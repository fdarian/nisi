# sidecar/walkthrough

The Phase 3 wiring layer: turns `@repo/walkthrough`'s pure schema/validation/prompt functions and
`@repo/harness-local`'s sandbox provider into the sidecar's `walkthrough.harnesses` /
`walkthrough.get` / `walkthrough.activeGeneration` / `walkthrough.generate` procedures. Neither of
those two packages does I/O or knows about the other — this directory is where they actually meet.
Harness-adapter plumbing that isn't walkthrough-specific (which CLI backs a harness, model
discovery, sandbox mode, read-only tool gating) lives one level up in
[sidecar/harness](../harness/AGENTS.md), shared by every caller that drives a `HarnessAgent`.

- `store.ts` — `WalkthroughStore`, persistence for generated walkthroughs (one row per session,
  regenerating overwrites) plus their derived coverage gaps (`uncoveredFiles` — path and the
  uncovered line ranges per file, so the frontend can open the diff pane on exactly the hunks the
  walkthrough skipped). Both live in the `content` column's own JSON envelope
  (`StoredContentEnvelope`) rather than a column each, so gaining `uncoveredFiles` needed no
  migration; a row written before that envelope existed decodes `uncoveredFiles` as `undefined`
  ("coverage never computed for this row"), distinct from `[]` ("computed, fully covered") — see
  `parseContent`'s doc. Lives here rather than in `@repo/walkthrough` because that package is
  deliberately I/O-free — see its AGENTS.md.
- `context.ts` — `gatherGenerationContext`: resolves a session's `repoRoot`/`baseRef`/`headRef`/PR
  title via `@repo/review`'s `ReviewStore` directly (not through `Store`, which has no raw "get one
  session" method) and fetches every changed file's patch + head content via `@repo/git`, producing
  both what `@repo/walkthrough`'s `buildOverview` needs for the agent's brief (the refs, the
  per-file list, the PR title) and what `evaluateWalkthrough` needs to validate the agent's answer
  turn by turn (`ChangedFileFacts` — each file's real patch and `lineCount`). Also reads
  `@repo/settings`'s `includeUncommitted` directly (there's no frontend request here to carry it)
  and threads it into both `@repo/git` calls, so the diff an agent explores matches what the user
  sees in Files Changed. Refuses outright (`HeadNotCheckedOut`) for a plain branch session whose
  `headRef` isn't what `repoRoot` actually has checked out — the harness runs a real coding agent
  directly against that worktree (`@repo/harness-local`), so an explicit, not-checked-out head
  would have the agent explore files that don't match the diff it was briefed on. A PR-backed
  session never trips this, since its `repoRoot` is a worktree nisi created and keeps checked out
  to exactly that PR's head. `generate.ts`'s `resolveContext` turns this into a specific `failed`
  event rather than the generic "could not read this session's diff" every other context failure
  collapses into.
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

- **Nothing a walkthrough generation can call writes to the worktree.** Two independent halves: the
  output tools are named `write_walkthrough`/`edit_walkthrough` (`WALKTHROUGH_TOOL_NAMES`) so they
  collide with no adapter's builtins, and `generate.ts` passes `sidecar/harness`'s
  `FILE_MUTATING_BUILTINS` as `inactiveTools` to switch the adapters' own file writers off.
  Overriding `write`/`edit` by key collision was the old design and failed both ways — Pi hung
  forever on it, Claude Code drifted to its *builtin* `Write` on a large context blob and left a
  stray `walkthrough.json` in the user's repo. `read`/`grep`/`glob`/`bash` stay active so the agent
  can explore the worktree itself — the point of the brief `@repo/walkthrough`'s `buildOverview`
  hands it, not a fallback. `generate.ts` feeds one name pair to *both* `createWalkthroughTools` and
  `buildSystemPrompt` — registering one set while telling the model another is the failure mode to
  watch for.
- **Regenerate is the same `generate` call, not a separate procedure.** The sidecar decides what
  "regenerate" means by what it finds: a matching live session (continue the conversation), else a
  stored walkthrough (fresh session, seeded with the prior result as context), else nothing (cold
  start) — see `live-sessions.ts`.
- **Session-not-found is thrown, not yielded.** `generateWalkthrough` throws
  `GenerateSessionNotFound` for an unknown `sessionId` so `http.ts` can map it to the contract's
  declared `NOT_FOUND`, matching `diff.files`/`diff.fileContents`'s precedent. Every other failure —  a git
  error, a harness/sandbox crash, a validation loop that never converges — yields an in-band
  `{ type: "failed" }` event instead, so the stream ends cleanly rather than dropping the connection.
- **`gatherGenerationContext` fetches every non-binary file's content with `force: true`**,
  bypassing `@repo/git`'s load-on-demand size tier — reference validation needs every changed
  file's real line count, not just the ones under 1MB, to tell a real `Location` from an
  out-of-range one. A file still past the *patch-only* tier (2MB) has no `newContent` even with
  `force`, and is simply omitted from `ChangedFileFacts` rather than faked with a zero line count —
  `@repo/walkthrough`'s own documented exemption for files with no head content.
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
- `sidecar/harness`'s `FILE_MUTATING_BUILTINS.codex` is empty (see its own AGENTS.md), so the
  `WALKTHROUGH_TOOL_NAMES` name-collision override above is a no-op for codex specifically; the
  custom tools are still reachable as plain user-defined tools regardless, which is what actually
  matters.
- `generate.ts` reads `fullStream`'s `error` parts via `sidecar/harness`'s `describeStreamError` — a
  loop that only watches `tool-call` sees a silent no-op turn on a transport failure and
  misattributes it to validation instead.
