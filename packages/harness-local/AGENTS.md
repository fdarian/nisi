# @repo/harness-local

`HarnessV1SandboxProvider` for AI SDK's `HarnessAgent` (`@ai-sdk/harness`), implemented over
`node:child_process` + `node:fs` instead of a virtual filesystem or a remote sandbox. See
`PLAN.md` (root), Phase 3's "Running the harness locally", for why this package exists: the two
shipped providers — `@ai-sdk/sandbox-vercel` (remote-only) and `@ai-sdk/sandbox-just-bash`
(a JS-reimplemented bash over an *in-memory* filesystem, despite the name) — can't run a coding
CLI against the user's actual git worktree. This package's sessions operate directly on real
disk, so `writeTextFile`, `run`, `spawn`, etc. do exactly what they say.

Template: `@ai-sdk/sandbox-just-bash`'s own source (`node_modules/.bun/@ai-sdk+sandbox-just-bash@*/…/src/`,
~250 lines across three files) implements the identical interface over its virtual FS — this
package mirrors its structure and swaps in real primitives.

- `src/local-sandbox-session.ts` — `LocalSandboxSession`, the plain `Experimental_SandboxSession`:
  file I/O via `node:fs/promises`, `run`/`spawn` via `node:child_process.spawn('/bin/bash', ['-c', command])`.
  This is what `restricted()` hands back — no infra members.
- `src/local-network-sandbox-session.ts` — `LocalNetworkSandboxSession extends LocalSandboxSession`,
  adding `id`/`defaultWorkingDirectory`/`ports`/`getPortUrl`/`stop`/`destroy`/`restricted`. `stop`
  kills processes this session `spawn`ed and releases its leased port; it never touches the
  directory itself, since that directory is the user's real worktree, not disposable sandbox state.
- `src/local-sandbox-provider.ts` — `LocalSandboxProvider`/`createLocalSandbox`. One instance per
  `defaultWorkingDirectory` (the target repo's *parent* — see "Reaching the real worktree" below).
- `src/port.ts` — `allocatePort`/`releasePort`: finds a free loopback port and leases it from an
  in-process registry so two sessions racing `createSession()` never get handed the same number.
- `src/sandbox-process.ts` — wraps a `ChildProcess` as `Experimental_SandboxProcess`
  (`Readable.toWeb` for the streams; `wait()`/`kill()`). Shared by both `run` (which drains it
  synchronously via `collectStream`) and `spawn` (which hands it back live).
- `src/stream-utils.ts` — `bytesToStream`/`collectStream`, the glue between the interface's
  stream-shaped `readFile`/`writeFile` and this package's byte-shaped primitives underneath.

No Effect here (beyond what the rest of the monorepo pulls in transitively) — this package's
entire surface implements a third-party plain-`Promise`/callback interface, so there is no
internal boundary to put Effect at; contorting it in would just add ceremony around calls into
`@ai-sdk/harness`, which itself has no Effect awareness.

## Non-obvious decisions

- **`resumeSession` is intentionally omitted**, same as `just-bash`. A resumed session would need
  to reattach to a *live* bridge process (the WebSocket the adapter dials still has to be
  answered by something), but this package's spawned processes are ordinary children of the host
  process — they exit when it does. Reattaching to `sessionId`'s old directory would produce a
  session object whose port nothing is listening on, which fails confusingly deep inside the
  adapter's WebSocket handshake instead of with a clear
  `HarnessCapabilityUnsupportedError('resume')` at the framework boundary. Omitting the method is
  what makes the framework raise that clear error itself.
- **`setNetworkPolicy`/`setPorts` are omitted.** There's no local enforcement primitive for
  outbound network policy, and every port this provider hands out is already leased per-session
  by `allocatePort` — nothing to replace. Matches `just-bash`'s reasoning for the same omissions.
- **`getPortUrl` ignores whether the port is actually bound to anything.** It always resolves to
  `${protocol}://127.0.0.1:<port>` — this package only reserves the *number*; the bridge adapter's
  own spawned process (via `spawn()`) is what binds it.
- **`run`/`spawn` unconditionally inject pnpm's `dangerouslyAllowAllBuilds` env override** (all
  three spellings — see `PNPM_BUILD_APPROVAL_ENV` in `local-sandbox-session.ts`). pnpm ≥10 blocks
  a fresh dependency's postinstall/build scripts behind an interactive `pnpm approve-builds`
  unless this is set, and every adapter's pinned-CLI bootstrap install (`@anthropic-ai/claude-code`
  for claude-code) trips it on the very first run — there's no TTY here to approve through, and
  the install happens at a path this package doesn't choose (see the bootstrap-dir gotcha below),
  so a file-based allowlist would have to guess the path. An env var applies regardless of it.
  Considered and rejected: writing a `pnpm-workspace.yaml`/`.npmrc` allowlist into the bootstrap
  dir (would require hardcoding or parsing out that path, and pnpm ≥11 dropped the older
  `onlyBuiltDependencies` config keys in favor of `allowBuilds`, so a file with the old shape
  would silently stop working); running `pnpm approve-builds` by hand (what this package's own
  live-verification hit before this fix — a manual, per-machine step every nisi user would
  otherwise be stuck on). The env-var injection is safe to apply on every `run`/`spawn` call, not
  just pnpm ones, because in practice only the framework's own bootstrap + the one `node
  bridge.mjs` spawn ever go through this session's `run`/`spawn` — everything the coding agent
  itself does once its session is live happens inside the already-spawned bridge/CLI process
  tree, never routed back through here.

## Gotchas

- **Reaching the real worktree**: the harness composes
  `<defaultWorkingDirectory>/<sandboxConfig.workDir>` (`resolveSessionWorkDir` in
  `@ai-sdk/harness`'s internal `sandbox-bootstrap.ts`). Callers using this provider against a real
  repo must set `defaultWorkingDirectory` to the repo's *parent* and `sandboxConfig.workDir` to
  the repo's folder name — the framework's own `mkdir -p` then no-ops on the already-existing
  directory. This package does not special-case that; it just doesn't fight it (no assumption
  anywhere that `defaultWorkingDirectory` is empty or provider-owned).
- **The claude-code adapter's bootstrap directory is hardcoded to `/tmp/harness/claude-code`** —
  an absolute path baked into `@ai-sdk/harness-claude-code`'s `claude-code-harness.ts`
  (`BOOTSTRAP_DIR`), not something `sandboxConfig` or this provider can redirect. PLAN.md already
  flags "there's no config to redirect it." Because this provider's file operations are real,
  persistent disk (not an ephemeral VM overlay), that path is stable across app relaunches on its
  own — the bootstrap marker (`/tmp/harness/claude-code/.bootstrap-<hash>.ok`) survives without
  this package needing to relocate anything under `NISI_DATA_DIR`. If a future adapter *does*
  expose a configurable bootstrap dir, revisit this note.
  - **Cold vs. warm `createSession()`**: measured (live-verification against real `claude`, this
    machine, 2026-07-28) at **~13–28s cold** (fresh clone + `pnpm install` of
    `@anthropic-ai/claude-code` and its deps, plus the CLI's own install step) vs. **~0.3–0.8s
    warm** (marker present, bootstrap is a single file read). The frontend must surface progress
    for the cold path specifically — a bare spinner reads as hung at 13–28s — and should be able
    to say *why* it's slow (first-time CLI install) rather than just that it is.
  - **"Once ever" is really "once per few days of active use."** macOS periodically reclaims
    `/tmp` entries untouched for about three days (`/private/tmp`'s periodic cleanup, not a
    per-reboot wipe). A nisi user who goes a few days without running a harness session will hit
    the cold path again through no fault of the marker logic — this is expected, not a bug in the
    bootstrap-skip check.
- **`sandboxSession.ports` must be non-empty before the claude-code adapter starts** — it reads
  `ports[0]` as the bridge port (`resolveBridgePort` in `claude-code-harness.ts`) and throws
  `HarnessCapabilityUnsupportedError` if empty. `LocalSandboxProvider.createSession` allocates one
  port per session up front for exactly this reason.
- `run`'s stdout/stderr must be drained via the same `Experimental_SandboxProcess` wrapper
  `spawn` uses (`toSandboxProcess` + `collectStream`), not a second, separate `'data'` listener on
  the raw `ChildProcess` streams — attaching both races `Readable.toWeb` for who gets to consume
  the underlying Node stream, and starves whichever loses.
- A process killed by `kill()`/an aborted signal reports `128 + signum` as its `exitCode` — the
  real value the shell itself would report as `$?`, not a placeholder.
