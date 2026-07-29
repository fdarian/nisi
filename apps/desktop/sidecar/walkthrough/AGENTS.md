# sidecar/walkthrough

The Phase 3 wiring layer: turns `@repo/walkthrough`'s pure schema/validation/prompt functions and
`@repo/harness-local`'s sandbox provider into the sidecar's `walkthrough.harnesses` /
`walkthrough.get` / `walkthrough.activeGeneration` / `walkthrough.generate` procedures. Neither of
those two packages does I/O or knows about the other — this directory is where they actually meet.

- `store.ts` — `WalkthroughStore`, persistence for generated walkthroughs (one row per session,
  regenerating overwrites). Lives here rather than in `@repo/walkthrough` because that package is
  deliberately I/O-free — see its AGENTS.md.
- `model-discovery.ts` — `discover*Models` (one real live-discovery function per harness — CLI
  subprocess for codex/opencode, `@anthropic-ai/claude-agent-sdk`'s `query()` for claude-code,
  `@earendil-works/pi-coding-agent`'s `ModelRegistry` for Pi, each timeout-bounded) and
  `createModelDiscoveryCache` (the fresh/stale/unavailable TTL cache in front of them — see the
  file's own comments for the fallback rules; follows oagent's `services/engine/src/model-catalog.ts`).
- `harnesses.ts` — `listHarnesses` (the registry `walkthrough.harnesses` returns — always all four,
  each carrying an `enabled` flag against the caller-supplied `enabledHarnesses` set and a
  `modelsStatus` from `model-discovery.ts`, so the onboarding picker can render every harness as a
  checkbox; `http.ts` reads `enabledHarnesses` from `@repo/settings`'s `SettingsStore` before calling
  in) and `createHarnessAdapter` (harness/model choice → a real `HarnessV1` adapter instance).
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

- **Custom `write`/`edit` tools override the harness's own file-editing builtins by name collision**,
  not by disabling anything. `createWalkthroughTools`'s tools are literally named `write`/`edit` —
  the same keys every adapter's builtin file tools use — and `HarnessAgentSettings.tools` documents
  user tools as taking precedence on key collision. So the model's usual editing muscle memory gets
  redirected at the walkthrough buffer with no per-adapter tool filtering needed; `read`/`bash`/`grep`
  etc. still work normally, so the agent can explore the real repo beyond what the digest includes.
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
  runs (a CLI update between the cache's TTL window and the call) — there's no `isAvailable` API to
  check a *harness* against up front, and discovery only validates that a model id exists, not that
  auth/access for it is configured. A stale id still only ever fails at `generate` time.
