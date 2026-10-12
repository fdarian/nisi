# sidecar/harness

Domain-agnostic harness-adapter plumbing: which CLI backs each `HarnessId`, whether it's on disk,
which models it offers, how to build a live `HarnessV1` adapter, and how to sandbox one against a
review session's worktree. Every feature that drives `@ai-sdk/harness/agent`'s `HarnessAgent`
against a review session imports from this directory rather than reaching into another feature's.

- `harness-bin.ts` — `HARNESS_CLI_BIN`, the one map of harness → CLI binary name + env override var
  (`claude`/`codex`/`opencode`; Pi has no entry, see `availability.ts`). Single source of truth both
  `model-discovery.ts` (spawning it) and `availability.ts` (checking it's present) resolve through
  `@repo/bin-resolver`.
- `availability.ts` — `checkHarnessAvailability`, a live per-harness binary-presence check
  (`@repo/bin-resolver`'s `checkBinAvailability`) — cheap enough to run on every `listHarnesses` call
  with no caching of its own. This is `HarnessInfo.available`, distinct from `enabled`
  (`@repo/settings`'s user declaration) — see `packages/sidecar-api/src/walkthrough.ts`'s doc.
- `model-discovery.ts` — `discover*Models` (one real live-discovery function per harness — CLI
  subprocess for codex/opencode via `runCli`, `@anthropic-ai/claude-agent-sdk`'s `query()` for
  claude-code, `@earendil-works/pi-coding-agent`'s `ModelRegistry` for Pi, each timeout-bounded and
  taking a `DiscoveryReason` for its own spawn/teardown debug logs). `runCli` and
  `discoverClaudeCodeModels` each tie their subprocess's lifetime to Effect's own interruption signal
  (`Bun.spawn`'s `signal` kill path / an `AbortController` passed into `query()`'s `options` and
  aborted in a `finally`) — a timed-out or interrupted discovery must not leave the CLI running as an
  orphan. `discoverPiModels` never spawns an OS subprocess at all (an in-process registry read), so
  neither concern applies to it.
- `model-store.ts` — `HarnessModelCache`, a `Context.Service` backed by `db/schema.ts`'s
  `harnessModelDiscoveries` table (one row per harness id, via `@repo/db`'s `SqliteDb`). Persistent
  stale-while-revalidate cache in front of `model-discovery.ts`: cold blocks on a real discovery;
  warm-and-fresh (within 24h) serves the row with no I/O; warm-and-stale serves the row immediately
  and forks a background revalidation (`Effect.forkDetach`) unless a failure backoff (1 minute,
  doubling per consecutive failure, capped at 24h) is still running. Every attempt — cold, background,
  or `force`d — goes through one single-flight path keyed by harness id, so concurrent callers for the
  same harness join one discovery instead of each spawning their own subprocess. Interrupted leaders
  wake waiting callers and release their flight slot. A run of failures never overwrites a
  previously-good model list, only the failure/backoff bookkeeping.
- `harnesses.ts` — `listHarnesses` (the registry `walkthrough.harnesses`/`walkthrough.refreshHarnesses`
  return — always all four, each carrying an `enabled` flag against the caller-supplied
  `enabledHarnesses` set and live `available`/`binaryPath` from `availability.ts`; no model probe
  runs on this path). Also `createHarnessAdapter` (harness/model choice → a real `HarnessV1` adapter).
- `models.ts` — `getHarnessModels`, the per-harness `walkthrough.models`/`refreshModels` path.
  Checks binary presence first, then calls `HarnessModelCache` with the corresponding discovery
  function. A missing CLI returns unavailable even if a previous model list is cached.
- `sandbox.ts` — the sandbox-backend seam: `SandboxOwner`, `SandboxBackend`, and `SANDBOX_BACKENDS`.
  See "Sandbox backends" below.
- `sandbox-local.ts` — `localSandboxBackend`, the only backend: `@repo/harness-local`'s
  `createLocalSandbox` with `resolveSandboxSettings` picking `"in-place"` vs `"relocated"` per harness
  for a `repoRoot`, and the fixed `~/.nisi/harness-sandbox` scratch root relocated mode uses — see
  `@repo/harness-local`'s own AGENTS.md ("Two sandbox modes") for why claude-code/codex/opencode need
  relocating and Pi doesn't. Relocation is a local-backend concern; other backends don't share it.
- `inactive-tools.ts` — `FILE_MUTATING_BUILTINS`: each adapter's builtin tools that write to the
  filesystem, fed to `HarnessAgent`'s `inactiveTools` so an agent stays read-only against the user's
  real worktree. `bash` is deliberately left active in every case — an agent needs it to explore, and
  it's the one remaining way to touch disk regardless of this list.
- `stream-errors.ts` — `describeStreamError`: normalizes `fullStream`'s `error` part payload into a
  message, or `undefined` for one with no real content (OpenCode's bridge emits a bare
  `{ type: "error" }` mid-session that must not fail an otherwise-healthy turn — see the function's
  own doc). `walkthrough/generate.ts` reads this directly on its turn loop's `"error"` parts rather
  than only watching `"tool-call"`, since a transport failure ends `fullStream` normally instead of
  throwing. `filterMeaninglessStreamErrors` reuses the same judgment (`describeStreamError(error)
  === undefined`) for a different job: dropping a meaningless `error` part from a `TextStreamPart`
  stream entirely, for a caller — `sidecar/chat`'s `stream.ts` — that hands the stream to AI SDK's
  `toUIMessageStream`, which turns *every* `error` part into a visible chunk unconditionally and
  offers no way to suppress one via its `onError` option (that only controls the chunk's message
  text).

## Sandbox backends

Where a harness CLI runs is chosen by the `sandboxMode` setting (`@repo/settings`). A feature that
builds a `HarnessAgent` (`chat/sessions.ts`, `walkthrough/generate.ts`) reads the setting when it
starts a *new* session — a live session keeps the backend it started on — and calls
`SANDBOX_BACKENDS[mode].create(harness, repoRoot, owner)`. It passes the returned `provider` and
`workDir` to `HarnessAgent` (`sandbox` / `sandboxConfig.workDir`) and later `session.stop()`s it.

```ts
type SandboxBackend = {
  create(harness: HarnessId, repoRoot: string, owner: SandboxOwner): Promise<{
    provider: HarnessV1SandboxProvider; // AI SDK's sandbox interface
    workDir: string;                    // relative; HarnessAgent throws on an absolute path
  }>;
};
type SandboxOwner =
  | { kind: "chat"; threadId: string }
  | { kind: "walkthrough"; reviewSessionId: string };
```

- `repoRoot` is the user's worktree; the agent must be able to read and edit it.
- `owner` says what the sandbox is for. A backend that keeps persistent machines can key one by it
  (a chat thread's id, or a review session's id for its walkthrough) so it can find and reuse or
  clean up that machine; ids stay stable for the owner's lifetime. Chat threads don't survive a
  sidecar restart, so anything keyed by `threadId` is orphaned by one. The local backend ignores it.
- `create` may be slow (starting a VM, downloading a runtime); chat shows "Setting up sandbox…"
  for a new thread while it runs. Throwing surfaces as a failed chat turn / `failed` walkthrough event.
- There is no admin surface (status, setup, stop, remove); add one when a backend has a consumer for it.

**Adding a backend**
1. Add the value to `SANDBOX_MODES` in `packages/settings/src/sandbox-mode.ts`. That widens the
   store's `Settings`, `@repo/sidecar-api`'s `SandboxMode` schema, and the frontend type.
2. Write `sandbox-<name>.ts` here exporting a `SandboxBackend`.
3. Add it to `SANDBOX_BACKENDS` in `sandbox.ts` — the `Record<SandboxMode, …>` fails to compile
   until you do.
4. Migration: none for the new value. The `sandboxMode` column is `text({ enum })` — typed in
   TypeScript, no SQLite CHECK. Only if the backend also needs new settings columns, generate one
   (`@repo/db`'s AGENTS.md; commit it alone).
5. UI: `HarnessesSection` in `src/features/settings/settings-page.tsx` doesn't render a Sandbox
   select while `SANDBOX_MODES` has one entry. Add a `SettingsRow` + `Select` over `SANDBOX_MODES`
   that calls `update({ sandboxMode })` when the second value lands.
6. The sidecar ships as a `bun build --compile` binary: anything the backend loads at runtime has to
   survive that (see [compiled-binary-differences](../../../knowledge/compiled-binary-differences.md)).
   `@repo/npm-tarball` downloads and verifies a pinned npm tarball into a cache directory.

## Gotchas

- **Pi discovery and Pi execution must read the same agent directory.** `discoverPiModels` uses
  `ModelRuntime.create()`'s defaults (which resolve under Pi's own `getAgentDir()`), and
  `createHarnessAdapter` passes that same `getAgentDir()` to `createPi`. Omit it and
  `@ai-sdk/harness-pi` mints a private agent dir with an empty `auth.json`, so every model
  discovery just listed as available fails at generate time with "No API key found for the
  selected model."
- Model discovery can still hand back an id that no longer works by the time a caller actually
  starts a session (a CLI update between the cache's TTL window and the call) — `available` only
  means the CLI binary is present, and discovery only validates that a model id exists, neither
  checks that auth/access for it is configured.
- Codex's adapter exposes no `write`/`edit` builtins at all (only `bash`/`webSearch` — its own
  patch-apply mechanism isn't surfaced as an AI-SDK tool), hence `FILE_MUTATING_BUILTINS.codex`'s
  empty list — codex has no builtin file writer to switch off in the first place.
- **A test that triggers `HarnessModelCache`'s background revalidation must keep the same
  `Effect.provide`d layer open across the trigger and the wait.** `Effect.provide`'s scope tears down
  (closing `SqliteDb`'s connection) as soon as the driving effect completes, but a background
  revalidation is a detached fiber (`Effect.forkDetach`) that keeps running after `get` itself
  returns — a test that builds a fresh layer per call and reads the row back through a second one can
  close the connection out from under that fiber's own write. Trigger, wait (on a `Deferred` the fake
  `discover` resolves, plus a short settle sleep), and read all inside one `Effect.provide`/
  `Effect.runPromise` call instead — see `test/model-store.test.ts`'s "warm and stale" tests. In the
  real sidecar this never happens: `index.ts` provides `HarnessModelCache`'s layer around the whole
  `Effect.never`-ending process lifetime, not per request.
