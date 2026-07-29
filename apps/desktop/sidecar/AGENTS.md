# sidecar

Implements `packages/sidecar-api`'s contract. Pure wiring — the actual git/persistence/agent logic
lives in `@repo/git`, `@repo/review`, `@repo/walkthrough`, and `@repo/harness-local`; this directory
composes them and translates between domain errors and oRPC error codes. See root `AGENTS.md` → "The
seam" for the port/token handshake this boots into.

- `index.ts` — boot: handshake file, builds `MainLayer` (`Store` + `WalkthroughStore` +
  `SettingsStore` + `SqliteDb` + `LoggingLive` + Bun platform services), runs one `Effect` program
  via `BunRuntime.runMain`. After binding its port, it claims `sidecar-lock.ts`'s `sidecar.lock`
  before touching `sidecar.json` at all — see that file for why an atomic `O_EXCL` create, not a
  check-then-act health check, is what closes the split-brain two sidecars sharing one
  `NISI_DATA_DIR` used to be able to fall into (see `apps/desktop/AGENTS.md`'s "Dev/prod isolation"
  for the main way that used to happen; the lock is the belt-and-suspenders for every other way,
  e.g. a manual `bun run sidecar` against the production data dir while the app's already running).
- `sidecar-lock.ts` — `acquireSidecarLock`/`releaseSidecarLock`/`publishSidecarJson`. The lock file
  (`sidecar.lock`, holding `{ port, token }`) is created via `wx` (`O_EXCL`) — the create either
  succeeds or fails atomically, so two sidecars booting at the same instant can't both proceed the
  way the old file-based check-then-act could. A losing process health-checks the lock's recorded
  owner over the same authed `health.check` channel the frontend and CLI use — never a staleness
  heuristic (file age, a reused PID) — and clears+retries once confirmed dead, bounded so a
  persistently-dead lock fails loudly instead of spinning forever. A `SIGKILL`'d owner skips the
  release effect entirely, but that's exactly the case the liveness check exists for: the next
  boot finds the lock, gets no answer from the dead port, and recovers the same way. `sidecar.json`
  itself is published via a temp file + `rename()` in the same directory — atomic on one
  filesystem, so Rust's `wait_for_sidecar_json` and the CLI's `readHandshake` never observe a
  partial write.
- `logging.ts` — `LoggingLive`: console (`Logger.consolePretty`, stderr) plus a
  `@repo/logging`-backed rotating file logger at `<dataDir>/logs/sidecar.log`, both gated by the
  same `LOG_LEVEL`-derived minimum level. This is the only place stdout-in-production's "goes
  nowhere" problem (Rust spawns the compiled sidecar fire-and-forget) actually gets fixed — read
  the file, don't rely on the console sink outside dev.
- `services.ts` — `AppServices`, the service union `mainContext` carries. One alias so `http.ts` and
  the walkthrough generation loop (which bridges Effect from a plain `async function*`, not `.effect()`)
  agree on what's available without each hand-rolling the union.
- `store.ts` — `Store`, the service `http.ts`'s git/review handlers depend on. One method per contract
  procedure (`openSession`, `listChangedFiles`, `setFileViewed`, `setRangeViewed`, ...), each composing
  `@repo/review`'s `ReviewStore` with `@repo/git`'s functions. `Session` here is the wire shape
  (`pr.baseRef`/`headRef` hoisted into the `pr` sub-object); `@repo/review`'s own `Session` keeps them
  at the top level since they apply whether or not there's a PR — `toWireSession` bridges the two.
  `readFileContent` is where Phase 3's range claims and Phase 2's whole-file toggle meet: it resolves
  both (with `oldPath` rename fallback for each — `resolveRangeClaims` re-queries on `oldPath` since
  `ReviewStore.listRangeClaims` is path-scoped, not a whole-session map like `listReviewStates`), reads
  every active claim's snapshot back out of the blob store via `buildReviewClaims`, and hands the whole
  list to `@repo/review`'s `reconcile()` — one call covers both review types.
- `http.ts` — the oRPC router. Each handler maps one or two domain packages' tagged errors to a
  declared contract error via `Effect.catchTag` + `errors.XXX(...)`; anything else (gh auth failures,
  decode errors, etc.) is an uncaught defect → oRPC's generic 500. Deliberately not exhaustive for
  Phase 1 — see `packages/sidecar-api/AGENTS.md` for which shapes got extra errors and why.
  `settings.get`/`settings.update` are the one pair of handlers backed directly by a domain
  package's own store (`@repo/settings`'s `SettingsStore`) rather than a sidecar-local wrapper —
  see that package's AGENTS.md for why it didn't need the `WalkthroughStore` split.
  `walkthrough.harnesses`/`walkthrough.refreshHarnesses` (the latter forcing a fresh model-discovery
  attempt, for the UI's manual refresh) read `SettingsStore` first and pass its `enabledHarnesses`
  into `listHarnesses`, which always returns all four harnesses, each flagged `enabled` against that
  set and `available` against a live `@repo/bin-resolver` check — every harness stays a checkbox,
  not a filtered list, whether enabled, available, both, or neither. See
  `sidecar/walkthrough/AGENTS.md`.
- `events.ts` — in-memory pub/sub for `events.subscribe`, ported from rheya's sidecar verbatim. oRPC's
  `.effect()` can't return a live async iterator (it resolves the generator via `runPromise`), so
  `events.subscribe` uses the lower-level `.handler(async function* ...)` instead, bridging this
  module's callback-style `subscribe` into a pull loop woken by a `wake` closure. `walkthrough.generate`
  uses the same `.handler()` escape hatch, for the same reason.
- `live-poll.ts` — `startLivePolling`, forked as a background fiber from `index.ts`'s boot program.
  Every `POLL_INTERVAL`, diffs each open session's `@repo/git` change signature against the previous
  tick (module-level `Map`, same in-memory-state shape as `events.ts`'s subscriber `Set`) and emits
  `session-files-changed` when it moved. Never reads file content itself — that's what makes it cheap
  enough to run on every open session on every tick; a stale-data refetch is the frontend's job once
  the event lands.
- `walkthrough/` — Phase 3's wiring layer. See its own AGENTS.md.

## Gotchas

- **`Layer.provideMerge`, not `Layer.provide`, throughout `index.ts`'s `MainLayer`.** `Store.layer`
  and `WalkthroughStore.layer` both need `SqliteDb` (`@repo/db`'s shared connection) and
  `FileSystem`/`ChildProcessSpawner` (via `@repo/review`'s `ReviewStore` and, per-call, `@repo/git`'s
  functions), but oRPC handlers and the walkthrough generation loop also reach some of those services
  *directly* — plain `provide` would satisfy each layer's own construction-time requirement without
  re-exposing the service for those per-call requirements. Same gotcha documented in
  `packages/review/AGENTS.md`, one layer up, now applied one more time for `ReviewStore` itself
  (`store.ts`'s `Store.layer`) and for `SqliteDb` (shared by both `Store` and `WalkthroughStore`).
- **`mainContext` is captured once, in `index.ts`'s boot program**, via `Effect.context<AppServices>()`,
  then passed into `startServer` and set as the `effect/context` for every oRPC request. Each request's
  handler effect isn't part of the boot program's fiber, so it can't `yield*` a service unless that
  service is in the context this way. The walkthrough generation loop (`walkthrough/generate.ts`)
  receives the same `mainContext` and bridges Effect from its own plain `async function*` with it.
