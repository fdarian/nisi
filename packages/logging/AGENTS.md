# @repo/logging

Shared Effect v4 logging plumbing for the sidecar and the CLI — a `LOG_LEVEL` env config both
honor identically, and a rotating file logger for the sidecar (the CLI only ever logs to its own
stderr, never a file — see `packages/cli/AGENTS.md`).

- `src/level.ts` — `minimumLogLevelConfig` (`LOG_LEVEL`, case-insensitive, defaults to `"Info"`,
  falls back to `"Info"` on an unrecognized value rather than failing boot over a logging knob) and
  `MinimumLogLevelLayer`, which installs it as the fiber's `References.MinimumLogLevel`.
- `src/file-logger.ts` — `rotatingFileLogger(path, { maxBytes, batchWindow })`: a `Logger` that
  appends `Logger.formatLogFmt`-formatted lines to `path`, batched (default 1s, same as
  `Logger.toFile`'s own default) and reopened per flush rather than holding one fd for the
  process lifetime — necessary so a rotation (renaming the file out from under the path) actually
  takes effect on the *next* write. Rotates to `<path>.1` (one backup, no unbounded growth) once
  the file passes `maxBytes` (default 10MB) — checked at the start of each flush, so rotation needs
  a second flush after crossing the cap to actually happen, not the write that crossed it.

## Gotchas

- Effect v4 has no `Layer.setConfigProvider`; override `LOG_LEVEL` in a test via
  `ConfigProvider.layer(ConfigProvider.fromUnknown({ LOG_LEVEL: "debug" }))`, not by mutating
  `process.env` (see `packages/review/AGENTS.md`'s gotcha — same race, `bun test` doesn't strictly
  serialize independent `test()` bodies).
- `rotatingFileLogger`'s rotation check runs once per flush, not once per log line — a test that
  wants to see a rotation needs *two* flushes (two separate `Logger.batched` scopes, or one scope
  that outlives two batch windows), not one large one.
