# @repo/harness-local

`HarnessV1SandboxProvider` for AI SDK's `HarnessAgent` (`@ai-sdk/harness`), implemented over
`node:child_process` + `node:fs` instead of a virtual filesystem or a remote sandbox. This package
exists because the two shipped providers — `@ai-sdk/sandbox-vercel` (remote-only) and
`@ai-sdk/sandbox-just-bash` (a JS-reimplemented bash over an *in-memory* filesystem, despite the
name) — can't run a coding CLI against the user's actual git worktree. This package's sessions
operate directly on real disk, so `writeTextFile`, `run`, `spawn`, etc. do exactly what they say.

Template: `@ai-sdk/sandbox-just-bash`'s own source (`node_modules/.bun/@ai-sdk+sandbox-just-bash@*/…/src/`,
~250 lines across three files) implements the identical interface over its virtual FS — this
package mirrors its structure and swaps in real primitives.

- `src/local-sandbox-session.ts` — `LocalSandboxSession`, the plain `Experimental_SandboxSession`:
  file I/O via `node:fs/promises`, `run`/`spawn` via `node:child_process.spawn('/bin/bash', ['-c', command])`.
  This is what `restricted()` hands back — no infra members.
- `src/local-network-sandbox-session.ts` — `LocalNetworkSandboxSession extends LocalSandboxSession`,
  adding `id`/`defaultWorkingDirectory`/`ports`/`getPortUrl`/`getPortEndpoint`/`stop`/`destroy`/`restricted`. `stop`
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

- **`run`/`spawn` widen `PATH`** (`spawnEnv` in `local-sandbox-session.ts`, via
  `@repo/bin-resolver#resolvedPath`) before merging in the caller's `env`. A macOS `.app` launched
  from Finder/`open` never runs login shell startup files, so the sidecar process's own `PATH`
  (inherited by every `run`/`spawn` call here) is missing wherever the user's shell-installed
  tools actually live — this bootstrap's own `pnpm` dependency, and the `node` the opencode and
  claude-code adapters spawn their bridges with, included. `resolvedPath()` must stay a per-call
  lookup rather than a module-level constant, or `walkthrough.refreshHarnesses`' path refresh can
  never take effect for the life of the process. See the comment at `spawnEnv`'s definition for
  the full reasoning; `sidecar/walkthrough/model-discovery.ts` (apps/desktop) hits the identical
  exposure for the harness CLIs' model-discovery spawns.
- **Dev hides this whole class of bug**: `bun run` prepends its own `node`-shim directory to a
  child's `PATH`, so a terminal-launched sidecar resolves `node` even with an otherwise bare
  `PATH`. The `bun build --compile` binary the `.app` ships does not. Verify `PATH`-sensitive
  changes against the compiled sidecar under a bare
  `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, never against `bun dev`.
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
- **`getPortUrl`/`getPortEndpoint` ignore whether the port is actually bound to anything.** Both
  always resolve to `${protocol}://127.0.0.1:<port>` — `getPortEndpoint` just wraps `getPortUrl`'s
  result in `{ url }` — this package only reserves the *number*; the bridge adapter's
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

## Two sandbox modes

`createLocalSandbox`'s `LocalSandboxSettings` (`mode: "in-place" | "relocated"`) picks where a
session's `defaultWorkingDirectory` lands, and returns `{ provider, workDir }` — the paired
`workDir` string the caller must feed straight into `HarnessAgent`'s `sandboxConfig.workDir`. The
two can't be resolved independently: the framework composes them as
`<defaultWorkingDirectory>/<workDir>` (`resolveSessionWorkDir`, `@ai-sdk/harness`'s internal
`sandbox-bootstrap.ts`), and `workDir` must stay relative — an absolute one throws
`HarnessAgent: \`sandboxConfig.workDir\` must be relative` (`harness-agent.ts`, validated in both
the constructor and per `createSession`).

- **`in-place`** — `defaultWorkingDirectory` is the repo's own parent, `workDir` its folder name;
  the framework's own `mkdir -p` then no-ops on the already-existing directory. Used only by
  **pi**: it has no bootstrap recipe at all (no `getBootstrap`, no `BOOTSTRAP_DIR`, no pkg-manager
  install anywhere in its source — it mirrors the workspace into an in-process VFS instead), so
  there's nothing outside `workDir` to relocate. Pi is also the one harness relocation would
  actively break: its path-containment check (`pi-remote-ops.ts`) canonicalizes the sandbox side
  but not `workDir` itself, so a symlinked `workDir` (what `relocated` mode below would produce)
  fails every read/write with `Pi path escapes the workspace`.
- **`relocated`** — `defaultWorkingDirectory` is a caller-supplied scratch root, and `workDir` is a
  path-hash-keyed symlink (`ensureRepoSymlink`, idempotent — created if missing, replaced if it
  points elsewhere, left alone otherwise, on every `createSession()`) pointing at the real repo.
  Used by **claude-code/codex/opencode**: each bootstraps a pinned CLI install into
  `defaultWorkingDirectory` on first use (`.harness-bootstrap/<harness>`, relative — see the
  gotcha below). Left in-place, that install runs inside whatever pnpm workspace the repo happens
  to sit in — for nisi reviewing its own worktrees, that's nisi's own workspace, and pnpm's
  global-store linking (`enableGlobalVirtualStore: true`) disagreeing with the bootstrap's own
  `--store-dir` makes pnpm try to purge and relink `node_modules`, which a GUI-launched sidecar has
  no TTY to confirm through (`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`).
  `apps/desktop/sidecar/walkthrough/generate.ts` picks the mode per harness and resolves the
  scratch root to a fixed `~/.nisi/harness-sandbox` — deliberately *not* `getDataDirConfig()`'s
  `NISI_DATA_DIR`-derived app-data dir, since `scripts/dev.ts` points that at a per-worktree
  session dir inside the nisi checkout, i.e. inside a pnpm workspace. `~/.nisi` is outside any
  checkout regardless of `NISI_DATA_DIR`, and shared across dev/prod/every repo on purpose: it
  only ever holds the pinned CLI install, keyed by a content-derived bootstrap marker, so there's
  nothing to split-brain over and dev gets a warm bootstrap for free — same "shared across
  sessions and repos" reasoning as never making the scratch root per-session.

## Gotchas

- **The bootstrap directory is a relative path under `defaultWorkingDirectory`, not an absolute
  `/tmp` path.** Verified against `@ai-sdk/harness-claude-code@1.0.55`
  (`BOOTSTRAP_DIR = '.harness-bootstrap/claude-code'`), `@ai-sdk/harness-codex@1.0.56`
  (`.harness-bootstrap/codex`), and `@ai-sdk/harness-opencode@1.0.55` (`.harness-bootstrap/opencode`)
  — each resolved via `posix.resolve(defaultWorkingDirectory, BOOTSTRAP_DIR)`
  (`bootstrap-recipe.ts`'s `resolveBootstrapPath`), never touching `workDir`. This is exactly why
  `defaultWorkingDirectory` needs relocating for these three harnesses (see "Two sandbox modes"
  above) rather than being redirectable through `sandboxConfig` alone. Because this provider's file
  operations are real, persistent disk (not an ephemeral VM overlay), the bootstrap marker
  (`.bootstrap-<hash>.ok`) survives across app relaunches on its own, same as it always did — the
  only thing relocation changes is which persistent directory it lives under.
  - **Cold vs. warm `createSession()`**: measured (live-verification against real `claude`, this
    machine, 2026-07-28) at **~13–28s cold** (fresh clone + `pnpm install` of
    `@anthropic-ai/claude-code` and its deps, plus the CLI's own install step) vs. **~0.3–0.8s
    warm** (marker present, bootstrap is a single file read). The frontend must surface progress
    for the cold path specifically — a bare spinner reads as hung at 13–28s — and should be able
    to say *why* it's slow (first-time CLI install) rather than just that it is.
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
