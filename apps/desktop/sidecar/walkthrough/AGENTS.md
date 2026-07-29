# sidecar/walkthrough

The Phase 3 wiring layer: turns `@repo/walkthrough`'s pure schema/validation/prompt functions and
`@repo/harness-local`'s sandbox provider into the sidecar's `walkthrough.harnesses` /
`walkthrough.get` / `walkthrough.activeGeneration` / `walkthrough.generate` procedures. Neither of
those two packages does I/O or knows about the other — this directory is where they actually meet.

- `store.ts` — `WalkthroughStore`, persistence for generated walkthroughs (one row per session,
  regenerating overwrites). Lives here rather than in `@repo/walkthrough` because that package is
  deliberately I/O-free — see its AGENTS.md.
- `harness-bin.ts` — `HARNESS_CLI_BIN`, the one map of harness → CLI binary name + env override var
  (`claude`/`codex`/`opencode`; Pi has no entry, see `availability.ts`). Single source of truth both
  `model-discovery.ts` (spawning it) and `availability.ts` (checking it's present) resolve through
  `@repo/bin-resolver`.
- `availability.ts` — `checkHarnessAvailability`, a live per-harness binary-presence check
  (`@repo/bin-resolver`'s `checkBinAvailability`) — cheap enough to run on every `listHarnesses` call
  with no caching of its own. This is `HarnessInfo.available`, distinct from `enabled`
  (`@repo/settings`'s user declaration) — see `packages/sidecar-api/src/walkthrough.ts`'s doc.
- `model-discovery.ts` — `discover*Models` (one real live-discovery function per harness — CLI
  subprocess for codex/opencode, `@anthropic-ai/claude-agent-sdk`'s `query()` for claude-code,
  `@earendil-works/pi-coding-agent`'s `ModelRegistry` for Pi, each timeout-bounded) and
  `createModelDiscoveryCache` (the fresh/stale/unavailable TTL cache in front of them, with a `force`
  option to bypass a cache hit — see the file's own comments for the fallback rules; follows oagent's
  `services/engine/src/model-catalog.ts`).
- `harnesses.ts` — `listHarnesses` (the registry `walkthrough.harnesses`/`walkthrough.refreshHarnesses`
  return — always all four, each carrying an `enabled` flag against the caller-supplied
  `enabledHarnesses` set, `available`/`binaryPath` from `availability.ts`, and a `modelsStatus` from
  `model-discovery.ts`, so the onboarding picker and the settings page can render every harness as a
  row; `http.ts` reads `enabledHarnesses` from `@repo/settings`'s `SettingsStore` before calling in).
  Model discovery only runs for a harness that's both `enabled` *and* `available` — an unavailable
  harness short-circuits to `modelsStatus: "unavailable"` without ever touching the discovery cache,
  so a harness that loses its CLI never reports a misleadingly-reassuring `"stale"`. Also
  `createHarnessAdapter` (harness/model choice → a real `HarnessV1` adapter instance).
- `context.ts` — `gatherGenerationContext`: resolves a session's `repoRoot`/`baseRef` via
  `@repo/review`'s `ReviewStore` directly (not through `Store`, which has no raw "get one session"
  method) and fetches every changed file's patch + head content via `@repo/git`, producing exactly
  what `@repo/walkthrough`'s pure functions need but can't fetch themselves — the digest's
  per-file patches and each file's `ChangedFileFacts.lineCount`.
- `live-sessions.ts` — the in-process `Map<sessionId, LiveWalkthroughSession>` a successful
  `generate` populates, so a regenerate can continue the same harness-agent conversation instead of
  starting cold. Gone on sidecar restart by design (`@repo/harness-local` omits `resumeSession` —
  cross-process resume isn't recoverable, so this doesn't pretend otherwise).
- `generation-log.ts` — `beginGeneration`/`recordGenerationEvent`/`attachToGeneration`/`getGeneration`,
  the in-process `Map<sessionId, …>` retaining one generation's full `GenerateEvent` history per
  session, so a subscriber that reattaches (tab switch, reload) replays what it missed instead of
  finding nothing — see the file's own comments for the replay/no-race guarantee. Same
  gone-on-restart posture as `live-sessions.ts`.
- `generate.ts` — `generateWalkthrough`, the bounded write → validate → feedback → edit loop,
  streamed as `GenerateEvent`s. Bridges Effect from its own plain `async function*` (the harness
  agent's API is Promise-based, not Effect) at exactly two points: gathering context up front, and
  persisting on success. `beginTrackedGeneration` wraps it for `http.ts`: awaits only the first
  event (preserving `GenerateSessionNotFound`'s synchronous-ish NOT_FOUND contract for the caller
  that started it), then drains the rest into `generation-log.ts` detached from that caller's
  connection — see its own comment for why the generation surviving a disconnect isn't new behavior
  this introduces, just behavior this now makes visible.

## Non-obvious decisions

- **Nothing a walkthrough generation can call writes to the worktree.** Two independent halves, both
  in `generate.ts`: the output tools are named `write_walkthrough`/`edit_walkthrough`
  (`WALKTHROUGH_TOOL_NAMES`) so they collide with no adapter's builtins, and `inactiveTools`
  (`FILE_MUTATING_BUILTINS`) switches the adapters' own file writers off. Overriding `write`/`edit`
  by key collision was the old design and failed both ways — Pi hung forever on it, Claude Code
  drifted to its *builtin* `Write` on a large digest and left a stray `walkthrough.json` in the
  user's repo. `read`/`grep`/`glob`/`bash` stay active so the agent can still explore beyond the
  digest; `bash` is the one remaining way to touch disk, deliberately accepted.
  `generate.ts` feeds one name pair to *both* `createWalkthroughTools` and `buildSystemPrompt` —
  registering one set while telling the model another is the failure mode to watch for.
- **Regenerate is the same `generate` call, not a separate procedure.** The sidecar decides what
  "regenerate" means by what it finds: a matching live session (continue the conversation), else a
  stored walkthrough (fresh session, seeded with the prior result as context), else nothing (cold
  start). PLAN.md's "resuming the prior agent session" only ever means the in-process case — see
  `live-sessions.ts`.
- **Session-not-found is thrown, not yielded.** `generateWalkthrough` throws
  `GenerateSessionNotFound` for an unknown `sessionId` so `http.ts` can map it to the contract's
  declared `NOT_FOUND`, matching `diff.files`/`diff.file`'s precedent. Every other failure —  a git
  error, a harness/sandbox crash, a validation loop that never converges — yields an in-band
  `{ type: "failed" }` event instead, so the stream ends cleanly rather than dropping the connection.
- **`gatherGenerationContext` fetches every non-binary file's content with `force: true`**,
  bypassing `@repo/git`'s load-on-demand size tier — the walkthrough needs every changed file's real
  line count to validate coverage, not just the ones under 1MB. A file still past the *patch-only*
  tier (2MB) has no `newContent` even with `force`, and is simply omitted from `ChangedFileFacts`
  rather than faked with a zero line count — `@repo/walkthrough`'s own documented exemption for
  files with no head content.
- **`generate` reattaches instead of erroring when a generation is already running for the
  session**, rather than adding a separate "attach" procedure — `http.ts`'s handler checks
  `generation-log.ts`'s `attachToGeneration` first and only calls `beginTrackedGeneration` when
  nothing's retained. This is what actually fixes the tab-switch bug: the generation was already
  surviving a dropped connection before this (see `@ai-sdk/harness`'s "session already has a turn
  in progress" guard, which is what a second cold `generate` call used to hit), the UI just had no
  way to see it. `walkthrough.activeGeneration` is the read-only counterpart for "should I even try
  to reattach" — call it before `generate` to avoid accidentally starting a fresh generation on
  every mount.

## Gotchas

- `Effect.result` (not `Effect.either`, and not inspecting `Effect.runPromise`'s rejection by hand)
  is how `generate.ts`'s `resolveContext` distinguishes `SessionNotFound` from every other context-
  gathering failure — see the comment there before changing this pattern.
- Codex's adapter exposes no `write`/`edit` builtins at all (only `bash`/`webSearch` — its own
  patch-apply mechanism isn't surfaced as an AI-SDK tool), so the name-collision override described
  above is a no-op for codex specifically; the custom tools are still reachable as plain
  user-defined tools regardless, which is what actually matters.
- Model discovery can still hand back an id that no longer works by the time `generate` actually
  runs (a CLI update between the cache's TTL window and the call) — `available` only means the CLI
  binary is present, and discovery only validates that a model id exists, neither checks that
  auth/access for it is configured. A stale id still only ever fails at `generate` time.
- **Pi discovery and Pi execution must read the same agent directory.** `discoverPiModels` uses
  `ModelRuntime.create()`'s defaults (which resolve under Pi's own `getAgentDir()`), and
  `createHarnessAdapter` passes that same `getAgentDir()` to `createPi`. Omit it and
  `@ai-sdk/harness-pi` mints a private agent dir with an empty `auth.json`, so every model
  discovery just listed as available fails at generate time with "No API key found for the
  selected model."
- **A harness's transport failure arrives as a `fullStream` `error` part, not a thrown error** —
  the stream still ends normally afterwards. `generate.ts` reads those parts explicitly; a loop
  that only watches `tool-call` sees a silent no-op turn and misattributes it to validation.
