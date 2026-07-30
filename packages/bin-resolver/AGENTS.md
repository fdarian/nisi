# @repo/bin-resolver

Resolving a CLI to an absolute path — or building a spawn-ready `PATH` — for when the process's
own `PATH` can't be trusted. A macOS `.app` launched from Finder/`open` inherits launchd's bare
`PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` and never runs a shell startup file, so every
tool the user installed through Homebrew, Bun, or a version manager (mise, asdf, nvm, fnm, volta)
is invisible to the packaged sidecar — `git`, `gh`, the harness CLIs, and the `node` a harness
bridge runs on, all of which resolve fine from a dev terminal. No dependencies and no Effect:
plain synchronous filesystem checks, since the callers are a `spawn` env object, module-level
constants and sidecar handlers alike, with no shared boundary to put a service at.

- `src/resolve-bin.ts` — `resolveBin` (absolute path for spawning one known binary, falling back
  to the bare name so the OS's own "command not found" reports the failure), `checkBinAvailability`
  (same order, but reports genuine absence — this is what `available` means in the harness list),
  `resolvedPath` (a whole widened `PATH` string, for a shell command whose binaries aren't known
  up front), `refreshLoginShellPath`. Candidates go `PATH` → `WELL_KNOWN_BIN_DIRS` → login-shell
  probe, appended and never prepended, so an already-resolvable tool keeps winning.
- `src/login-shell-path.ts` — the probe: one `$SHELL -l -i -c` subprocess reading a
  delimiter-framed `printenv PATH`, memoized for the process's lifetime behind an explicit
  `refresh`. Degrades to `[]` on every failure path, so it only ever contributes extra candidates.

## Who pays for the probe

The shell subprocess is the only expensive step here, and callers reach it unevenly on purpose:

- `resolveBin`/`checkBinAvailability` probe **only when `PATH` and the well-known dirs both miss**.
  In dev — a terminal-launched sidecar, whose `PATH` already has everything — it never runs at all.
- `resolvedPath()` always probes: there's no "not found" signal to trigger on when the caller
  won't say which binaries its shell string will reach for. `@repo/harness-local`'s `spawnEnv` is
  the caller, and has to keep calling it **per invocation** rather than capturing a module-level
  constant, or a refresh can never take effect for the life of the process.
- `refreshLoginShellPath()` is wired into `walkthrough.refreshHarnesses`
  (`apps/desktop/sidecar/http.ts`) — the only thing that makes a CLI installed *while nisi is
  running* visible. It reaches every per-call consumer, but not `@repo/git`'s `GIT_BIN`/`GH_BIN`,
  which resolve once at module load and stay pinned.

`HarnessInfo.available` is live for a different reason: `sidecar/walkthrough/availability.ts`
never caches `checkBinAvailability` at all (unlike the model lists next to it), so every
`listHarnesses` call re-checks the disk. The refresh above only drops the *probe's* memo.

## Gotchas

- Every export shares one module-level memo, so `test/resolve-bin.test.ts` sets `SHELL=""` and
  warms it in `beforeAll` — without that, any test whose lookup misses `PATH` spawns the
  developer's real login shell (seconds of wall clock, and a per-machine answer). Test the
  memoization itself through `createLoginShellPathCache` with a stub probe; that's what the
  factory exists for.
- `bun run` prepends its own `node`-shim directory to a child's `PATH`, so a terminal-launched
  sidecar resolves `node` even under an otherwise bare `PATH` while the `bun build --compile`
  binary the `.app` ships does not — this package's entire failure mode is invisible in dev.
  [knowledge/compiled-binary-differences.md](../../knowledge/compiled-binary-differences.md) covers
  the rest of that class; `@repo/harness-local`'s AGENTS.md has the bare-`PATH` reproduction recipe
  to verify a change against the compiled sidecar.
