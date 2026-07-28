# @repo/cli

The `nisi` command. One command, no subcommands: detects the PR for the current directory (or
`nisi <path>`) and opens it in the desktop app. See `PLAN.md` (root), "The seam", for the design
this implements.

- `src/index.ts` — the `Command` (Effect CLI, `effect/unstable/cli`), argument parsing, and
  terminal reporting. Fails fast via `@repo/git`'s `resolveRepoRoot` before touching the sidecar
  at all, so a non-repo directory doesn't pay for an app-spawn round trip.
- `src/handoff.ts` — the seam itself: read `sidecar.json`, POST `sessions.open` with a short
  per-attempt timeout, and only spawn the app (`app-launch.ts`) when that POST can't reach
  anything — never on a declared app-level error, which means the sidecar is alive and answered.
  Always the same POST either way.
- `src/app-launch.ts` — resolves "the app" (env override, `/Applications`, or a locally-built
  release bundle — nisi has no install channel yet) and launches it via `open -a`, which hands
  off to LaunchServices and exits on its own.

## Gotchas

- `@effect/cli` is dead on the `effect@beta` line — this is `effect/unstable/cli`
  (`Command`/`Flag`/`Argument`), run via `Command.run(cmd, { version })` +
  `Effect.provide(BunServices.layer)` + `BunRuntime.runMain`.
- A stale `sidecar.json` (app was killed) must never hang the CLI: `handoff.ts` tells "the
  sidecar answered" apart from "nothing's there" via `@orpc/client`'s `safe()` +
  `isDefinedError` — only a transport-level failure (not a declared contract error) triggers the
  app-spawn path.
- `BunRuntime.runMain(..., { disableErrorReporting: true })` — the CLI prints its own clean
  message per outcome and fails with an empty `ReportedFailure` sentinel just to get a non-zero
  exit code; letting the default reporter run too would double-print a stack trace under it.
