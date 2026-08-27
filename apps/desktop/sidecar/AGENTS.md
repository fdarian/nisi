# sidecar

Implements `packages/sidecar-api`'s contract. Pure wiring — the actual git/persistence/agent logic
lives in `@repo/git`, `@repo/review`, `@repo/walkthrough`, and `@repo/harness-local`; this directory
composes them and translates between domain errors and oRPC error codes. See root `AGENTS.md` → "The
seam" for the port/token handshake this boots into.

- `index.ts` — boot, in two layers with different lifetimes. `EarlyLayer` (`LoggingLive` + Bun
  platform services) wraps the *whole* program, so even the first "starting up" log line reaches
  the rotating file logger. `MainLayer` (`Store` + `WalkthroughStore` + `SettingsStore` +
  `SqliteDb`) wraps only the program's *tail* — deliberately provided at that nested point instead
  of around the whole program, so `SqliteDb`'s connection (and Drizzle's migrations) can't open
  until after the prefix has already run: bind the port (`http.ts`'s `bindHealthCheckServer`,
  health-check-only — no `AppServices` needed yet), claim `sidecar-lock.ts`'s `sidecar.lock`, and
  publish `sidecar.json`. See that file for why an atomic `O_EXCL` create, not a check-then-act
  health check, is what closes the split-brain two sidecars sharing one `NISI_DATA_DIR` used to be
  able to fall into (see `apps/desktop/AGENTS.md`'s "Dev/prod isolation" for the main way that
  used to happen; the lock is the belt-and-suspenders for every other way, e.g. a manual `bun run
  sidecar` against the production data dir while the app's already running) — and why gating
  `MainLayer` behind it is what makes that guarantee extend to `app.db` too: two cold boots
  racing on Drizzle's `CREATE TABLE IF NOT EXISTS` migration step is the same class of bug one
  layer down, not a separate one. `@repo/db`'s `busy_timeout`/WAL pragmas (`client.ts`) are the
  belt-and-suspenders for every *other* concurrent opener of `app.db` (a stray script, a future
  reader) that this lock doesn't cover, since it only ever governed `sidecar.json`.
- `sidecar-lock.ts` — `acquireSidecarLock`/`releaseSidecarLock`/`publishSidecarJson`. The lock file
  (`sidecar.lock`, holding `{ port, token }`) is created via `wx` (`O_EXCL`) — the create either
  succeeds or fails atomically, so two sidecars booting at the same instant can't both proceed the
  way the old file-based check-then-act could. A losing process reads the lock's recorded owner:
  when it recorded the *same port* this process is already listening on, it's taken over without a
  health check — a TCP port has exactly one owner, and this process is demonstrably it (`index.ts`
  binds before acquiring the lock), so that owner can only be this process's own previous
  incarnation — the common case in dev, where `scripts/dev.ts` pins the sidecar port to a devsess
  sticky port for the whole session (see root `AGENTS.md`'s "The seam"), so this covers a fresh
  `bun dev` of the same session finding a previous one's dead sidecar, not just a `bun --watch`
  restart mid-run — or, in prod, a `SIGKILL`'d sidecar whose ephemeral port the OS reassigned. Never
  a live rival. Any other recorded owner is health-checked over the same authed `health.check`
  channel the frontend and CLI use — never a staleness heuristic (file age, a reused PID) — and
  cleared+retried once confirmed dead, bounded so a persistently-dead lock fails loudly instead of
  spinning forever. A `SIGKILL`'d owner skips the release effect entirely, but that's exactly the
  case the liveness check exists for: the next boot finds the lock, gets no answer from the dead
  port, and recovers the same way. `sidecar.json` itself is published via a temp file + `rename()`
  in the same directory — atomic on one filesystem, so Rust's `wait_for_sidecar_json` and the CLI's
  `readHandshake` never observe a partial write. Deliberately not `deskkit/sidecar`'s
  `acquireSidecar`, even though `scripts/dev.ts`/the CLI now read `sidecar.json` through that same
  package's `awaitSidecarHandshake`/`readSidecarJson` — see `publishSidecarJson`'s doc comment for
  why the write side stays here.
- `logging.ts` — `LoggingLive`: console (`Logger.consolePretty`, stderr) plus a
  `@repo/logging`-backed rotating file logger at `<dataDir>/logs/sidecar.log`, both gated by the
  same `LOG_LEVEL`-derived minimum level. This is the only place stdout-in-production's "goes
  nowhere" problem (Rust spawns the compiled sidecar fire-and-forget) actually gets fixed — read
  the file, don't rely on the console sink outside dev.
- `services.ts` — `AppServices`, the service union `mainContext` carries. One alias so `http.ts` and
  the walkthrough generation loop (which bridges Effect from a plain `async function*`, not `.effect()`)
  agree on what's available without each hand-rolling the union.
- `diff-head.ts` — `resolveDiffHead`: for a session's `headRef` and whether it's a PR-backed
  session, decides `DiffHead` — `{headRef, worktreeEligible}` — the single place that answers
  "which ref is this session's head right now, and is `repoRoot`'s worktree safe to overlay on it."
  Pure and session-shape-agnostic (no `ReviewStore`/blob dependency, just `@repo/git`'s
  `resolveCurrentBranch`), so it's unit-tested directly against real temp repos rather than through
  `Store`'s full DB-backed layer. A PR-backed session is always eligible without even checking (its
  `repoRoot` is a worktree nisi created and keeps checked out to exactly that PR's head — see
  `@repo/git`'s `worktree.ts` — and the PR's own `headRef` isn't guaranteed to resolve as a ref
  there at all, since nisi checks it out onto its own `nisi/pr-<n>/<headRef>` branch). A plain
  branch session compares `headRef` against `resolveCurrentBranch` fresh on every call rather than
  once at open time, so it drifts in and out of eligibility as the caller checks different branches
  out — this is what lets a session self-heal, but also what makes every read (`listChangedFiles`/
  `readFileContents`) and write (`setFileViewed`/`setRangeViewed`) path in `store.ts` need to
  consult it independently, on every call, rather than trusting a value resolved elsewhere. Also
  owns `InvalidHeadRef`/`validateHeadRef` — `resolveSessionTarget`'s explicit-`headRef` validation,
  mirroring `store.ts`'s own `InvalidBaseRef`.
- `store.ts` — `Store`, the service `http.ts`'s git/review handlers depend on. One method per contract
  procedure (`openSession`, `listChangedFiles`, `setFileViewed`, `setRangeViewed`, ...), each composing
  `@repo/review`'s `ReviewStore` with `@repo/git`'s functions. `Session` here is the wire shape — a
  discriminated `target` (`{kind: "pr", ...}` or `{kind: "branch", baseRef, headRef}`, mirroring
  `packages/sidecar-api`'s `SessionTarget`) rather than a nullable `pr`, since a branch session still
  has a real base and head to review against; `@repo/review`'s own `Session` keeps `baseRef`/`headRef`
  at the top level and `pr` nullable instead, since those apply whether or not there's a PR —
  `toWireSession` bridges the two. `openSession` takes an `OpenSessionTarget` selector
  (`"auto"`/`"pr"`/`{"branch", baseRef?, headRef?}`, defaulting to `"auto"`) mirroring the CLI's
  `nisi`/`nisi pr`/`nisi diff [<base>]` grammar (`<base>` may be a range, `<base>..<head>` or
  `<base>...<head>` — see `packages/cli/AGENTS.md`); `resolveSessionTarget` is where that selector
  turns into the `baseRef`/`headRef`/`pr` triple `ReviewStore.openSession` needs, skipping
  `resolveReviewTarget` (and its GitHub round trip) entirely when `"branch"` supplies its own
  `baseRef` — but still validating that ref via `resolveMergeBase`, failing with `InvalidBaseRef`
  (git's own `stderr` attached) before a session is ever persisted, rather than letting a typo
  surface later as an opaque failure the first time Files Changed loads. An explicit `headRef`
  alongside it is validated the same way, via `diff-head.ts`'s `validateHeadRef`
  (`InvalidHeadRef`), and used as-is, in place of the current checkout. `"pr"` fails with
  `NoPullRequest` when `resolveReviewTarget` finds none open — the one selector that doesn't
  degrade to a branch diff on its own.
  Every method that touches a session's files — `listChangedFiles`/`readFileContents` (read) and
  `setFileViewed`/`setRangeViewed` (write) alike — resolves `diff-head.ts`'s `resolveDiffHead` via
  the local `resolveSessionDiffHead` adapter before doing anything else, and gates on its result the
  same way: `includeUncommitted` only applies when `worktreeEligible`, and every `@repo/git` call
  (or, on the write side, `readCurrentBlobContent`'s worktree-vs-`readFileContentsAtRef` choice)
  takes the decided `headRef` rather than defaulting to `HEAD`. This is deliberately re-derived on
  every call rather than decided once when a session opens and reused — the read and write sides
  must never independently guess whether the worktree still belongs to this session, since that's
  exactly how they could (and once did) disagree.
  `changedSinceReview` (`attachReviewState`'s sidebar badge, and `readFileContents`'s
  size-gated-content fallback) honors the same gated flag via `readCurrentHashes`, which rehashes a
  ticked file's current content with `@repo/review`'s own `hashContent` — worktree bytes when
  worktree-eligible and `includeUncommitted` is `true`, otherwise `@repo/git`'s
  `readFileContentsAtRef` (one batched read over just the ticked paths, not the whole diff) against
  `HEAD` or the session's own `headRef`.
  `readFileContents` is where Phase 3's range claims and Phase 2's whole-file toggle meet: it resolves
  both (with `oldPath` rename fallback for each — `resolveRangeClaims` re-queries on `oldPath` since
  `ReviewStore.listRangeClaims` is path-scoped, not a whole-session map like `listReviewStates`), reads
  every active claim's snapshot back out of the blob store via `buildReviewClaims`, and hands the whole
  list to `@repo/review`'s `reconcile()` — one call covers both review types. When that reconciliation
  comes back with a non-null `reviewedBaseline`, `readFileContents` re-derives `patch`/`oldContent`
  against it via `@repo/git`'s `diffContentsPatch` instead of leaving `getFileContents`' plain
  `base → head` pair in place, and reports `baselineKind: "reviewed"` on the wire so the diff pane knows
  an empty patch means "nothing new since your last pass." Skipped (stays `"base"`) whenever there's no
  active claim, or the content is size-gated — reconciliation needs the full content a size gate
  withheld.
  Every method that shells out against a session's files (`listChangedFiles`, `readFileContents`,
  `setFileViewed`, `setRangeViewed`) resolves `repoRoot` through `resolveLiveRepoRoot` rather than
  trusting the persisted `ReviewSession.repoRoot` directly — a `git worktree move`, or an external
  tool (`wt`/worktrunk) relocating a worktree nisi created, otherwise leaves every git spawn against
  that session `ENOENT`ing forever. See `@repo/git`'s `revalidateWorktreePath` for the mechanism
  (cheap `stat` fast path, branch-keyed re-resolution against the PR's known main clone, tagged
  failure when the worktree is genuinely gone); `resolveLiveRepoRoot` is just the piece that persists
  a healed path back onto the session row (`ReviewStore.updateRepoRoot`) so every other caller —
  including the next `live-poll.ts` tick — sees the fix too. `resolveSessionRepoRoot` is the
  sessionId-keyed public wrapper `live-poll.ts` calls, since it only ever starts from an id.
- `http.ts` — `bindHealthCheckServer` binds the real port immediately with a hand-rolled
  `health.check`-only handler (no `AppServices` needed), which `index.ts` records in the lock
  before `AppServices` exists at all; `attachRouter` swaps in the full oRPC router afterward via
  `server.reload` — same port, no restart, so a concurrent liveness check never observes a gap
  where nothing's listening. The router itself: each handler maps one or two domain packages'
  tagged errors to a declared contract error via `Effect.catchTag` + `errors.XXX(...)`; anything
  else (gh auth failures, decode errors, etc.) is an uncaught defect → oRPC's generic 500.
  Deliberately not exhaustive for Phase 1 — see `packages/sidecar-api/AGENTS.md` for which shapes
  got extra errors and why.
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
  `session-files-changed` when it moved; a stale-data refetch is the frontend's job once the event
  lands. `checkSessionForChanges` reads `SettingsStore`'s `includeUncommitted` itself (this poller has
  no per-request input to carry it) and threads it into `readRepoChangeSignature` — off (the common
  case) skips `@repo/git`'s `status`/hashing outright, on hashes each dirty path's content. The stored
  signature carries the mode it was read under alongside the signature itself: a mode flip changes the
  signature's *shape* for a reason unrelated to the repo, so a check that lands right after the user
  toggles the setting re-baselines silently instead of emitting a spurious `session-files-changed` —
  the frontend already refetches on that toggle on its own (folded into its query key).
  `checkSessionForChanges` resolves `repoRoot` via `Store.resolveSessionRepoRoot` before reading a
  signature (see `store.ts` above) rather than trusting a session's `repoRoot` as listed — but a
  session whose worktree is genuinely gone (`WorktreeRelocationFailed`) gets added to
  `unresolvableSessions` and logged exactly once: that condition can't self-clear tick-to-tick, so
  retrying it every `POLL_INTERVAL` forever would just re-produce the WARN flood a dead `cwd` used
  to cause on every git spawn. Pruned from that set the same tick a session closes.
- `walkthrough/` — Phase 3's wiring layer. See its own AGENTS.md.
- `chat/` — the quick-chat popup's read-only `HarnessAgent` conversations, one per thread. See its
  own AGENTS.md.
- `updater/` — macOS Homebrew-cask auto-update. `service.ts`'s `Updater` owns a `Ref<UpdateState>`
  and is the only writer of it: `startChecks()` (forked from `index.ts`'s boot program, same shape as
  `startLivePolling` above) drives `idle ⇄ available` on an hourly `Schedule`, stopping for good the
  first time it finds this isn't a cask install; `download`/`restart` (the `update.*` oRPC handlers)
  own every other transition, so the poller can never stomp a download in flight or a cached artifact
  waiting for a restart. `homebrew.ts` resolves `brew` and shells out to it (`list --cask --versions`,
  `update`, `fetch --cask`); `tap-version.ts` reads the tap's cask file over HTTP and compares semver
  against the installed version — brew itself, not GitHub's release API, since a release can ship
  ahead of the tap. Every brew invocation sets `HOMEBREW_NO_AUTO_UPDATE=1` except the explicit
  `brew update` calls (`homebrew.ts`'s `refreshTap`, and the restart script below) — that env var only
  suppresses brew's *implicit* auto-update ahead of `install`/`upgrade`/`fetch`, not an explicit
  `update` command, so `refreshTap` still forces a fresh read of the third-party
  `fdarian/homebrew-tap` clone; `download` runs it right before `brew fetch --cask nisi`, aborting to
  `failed` if the refresh itself fails rather than fetching against a stale tap. `restart-helper.ts`
  writes a POSIX-sh script to `<data dir>/update/` and spawns it detached (`ChildProcessSpawner`,
  `detached: true`, every stdio `"ignore"`, `handle.unref` before its own scope closes) so it outlives
  the sidecar; the script waits for the app to quit, runs its own `brew update` for the same reason,
  then `brew upgrade --cask nisi` against the artifact `download` already cached, and relaunches
  either way — recording the installed version before and after, plus the upgrade's exit code, to
  `<data dir>/update/restart-outcome.json`. `restart-outcome.ts` reads and clears that marker on the
  next boot, before `Updater`'s first check can run: if the installed version didn't move, `Updater`
  starts in `failed` with a message pointing the user at running
  `brew update && brew upgrade --cask nisi` by hand, instead of quietly re-offering the same
  "available" update forever.

## Gotchas

- **`Layer.provideMerge`, not `Layer.provide`, throughout `index.ts`'s `MainLayer`.** `Store.layer`
  and `WalkthroughStore.layer` both need `SqliteDb` (`@repo/db`'s shared connection) and
  `FileSystem`/`ChildProcessSpawner` (via `@repo/review`'s `ReviewStore` and, per-call, `@repo/git`'s
  functions), but oRPC handlers and the walkthrough generation loop also reach some of those services
  *directly* — plain `provide` would satisfy each layer's own construction-time requirement without
  re-exposing the service for those per-call requirements. Same gotcha documented in
  `packages/review/AGENTS.md`, one layer up, now applied one more time for `ReviewStore` itself
  (`store.ts`'s `Store.layer`) and for `SqliteDb` (shared by both `Store` and `WalkthroughStore`).
- **`mainContext` is captured once, inside `index.ts`'s `MainLayer`-provided tail**, via
  `Effect.context<AppServices>()` — only once the lock is held and `AppServices` is built, not at
  the very start of boot — then passed into `attachRouter` and set as the `effect/context` for
  every oRPC request from that point on. Each request's handler effect isn't part of the boot
  program's fiber, so it can't `yield*` a service unless that service is in the context this way.
  The walkthrough generation loop (`walkthrough/generate.ts`)
  receives the same `mainContext` and bridges Effect from its own plain `async function*` with it.
