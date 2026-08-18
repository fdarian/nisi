# @repo/cli

The `nisi` command: bare `nisi` auto-detects (PR if one's open, else the default branch), `nisi pr`
requires a PR and errors clearly when there is none, `nisi diff [<base>]` diffs an explicit base
(default branch when omitted), ignoring any open PR even when one exists. `<base>` can also be a
range — `<base>..<head>` or `<base>...<head>` — to diff two arbitrary refs, neither of which has to
be the current checkout; see `src/base-argument.ts`. All three take the same optional `[<path>]`
positional `nisi` always has (`diff` reads it second, after `<base>`). `nisi completion zsh` prints a
zsh completion script for the whole tree. See `apps/desktop/AGENTS.md`'s "The seam" section for the
handoff design this implements, and `packages/sidecar-api/src/sessions.ts`'s `OpenSessionTarget` for
the wire shape this grammar maps to.

- `src/index.ts` — the `Command` tree (Effect CLI, `effect/unstable/cli`): `nisi` with `pr`/`diff`/
  `completion` as subcommands (`Command.withSubcommands`), `pr`/`diff` sharing one
  `run(pathArg, target)` that does the actual argument parsing, terminal reporting, and repo-root
  resolution — the two commands differ only in which `OpenSessionTarget` they resolve to
  (`"pr"`/`{"branch", baseRef?, headRef?}`) before calling `handoff`; `nisi` itself (no subcommand)
  resolves `"auto"` the same way. Fails fast via `@repo/git`'s `resolveRepoRoot` before touching the
  sidecar at all, so a non-repo directory doesn't pay for an app-spawn round trip. Logging
  (`@repo/logging`'s `MinimumLogLevelLayer`, gated by `LOG_LEVEL`) always routes to stderr
  (`Logger.withConsoleError`) regardless of level, so `LOG_LEVEL=debug nisi` never changes what a
  script piping the CLI's stdout would see — stdout stays exactly the one human-facing result line
  each outcome already prints via `Console.log`/`Console.error`.
- `src/base-argument.ts` — `parseBaseArgument`: splits `diff`'s `<base>` positional into
  `{baseRef, headRef?}`, non-greedy on the first run of 2–3 dots (safe since git forbids `..`
  inside a single ref name — see the module's own doc comment). `index.ts` sends `headRef` through
  to `sessions.open` only when the argument actually was a range; a bare ref keeps today's
  behavior (diff against the current checkout).
- `src/completion.ts` — `zshCompletionScript`, the string `nisi completion zsh` prints. A hand-rolled
  `_nisi` zsh function, not generated output — see the file's own doc comment for why, and the Gotchas
  section below. It pulls ref candidates from `git for-each-ref` directly rather than shelling out to
  `nisi`, splits a partially-typed `<base>` the same way `base-argument.ts` does (so `main..<TAB>`
  offers head refs while keeping the `main..` prefix on the line via `compadd -P`), and degrades to no
  candidates, silently, outside a git repo.
- `src/handoff.ts` — the seam itself: read `sidecar.json`, POST `sessions.open` (now `{ cwd, target
  }`) with a short per-attempt timeout, and only spawn the app (`app-launch.ts`) when that POST can't
  reach anything — never on a declared app-level error, which means the sidecar is alive and
  answered. Always the same POST either way; `target` just rides along, uninterpreted by this module.
  Opening a session and putting the app in front are separate steps (`openSession`, then the focus in
  `handoff`): only one path spawns the app, but every path that ends in a session wants it frontmost.
- `src/app-launch.ts` — resolves "the app" (env override, `/Applications`, or a locally-built
  release bundle — nisi has no install channel yet) and `open -a`s it, which hands off to
  LaunchServices and exits on its own — a launch when the app is cold, an activate when it's
  already running.

## Gotchas

- `@effect/cli` is dead on the `effect@beta` line — this is `effect/unstable/cli`
  (`Command`/`Flag`/`Argument`), run via `Command.run(cmd, { version })` +
  `Effect.provide(BunServices.layer)` + `BunRuntime.runMain`.
- `effect/unstable/cli`'s own `--completions zsh` generator doesn't work for this command tree: `nisi`
  declares both a positional `path` and subcommands, and the generator emits an `_arguments` spec for
  each at position 1, so `_arguments -C` aborts with a doubled-definition error before any completion
  state is set. `completion.ts`'s `_nisi` is hand-rolled instead — see its own doc comment.
- `diff <base>..<head>` and `diff <base>...<head>` mean exactly the same thing — both resolve to
  `merge-base(<base>, <head>) -> <head>`, deliberately not git's own two-dot-vs-three-dot
  distinction. A review tool always wants the merge-base view, matching what the bare-ref form
  already resolves to via `@repo/git`'s `resolveMergeBase`.
- An explicit `<head>` in the range form is never the current checkout by assumption — the sidecar
  (`apps/desktop/sidecar/diff-head.ts`'s `resolveDiffHead`) forces committed-only diffing for it and
  never overlays worktree/uncommitted changes, even when that setting is on, since `repoRoot`'s
  worktree has no guaranteed relationship to an arbitrary named ref.
- A stale `sidecar.json` (app was killed) must never hang the CLI, and a live-but-slow sidecar
  must never be spawned a second time: `handoff.ts` splits a non-response three ways — a declared
  app-level error (`safe()` + `isDefinedError`) means the sidecar answered; a connection failure
  means nothing's listening (`unreachable`, spawns the app); `AbortSignal.timeout`'s own
  `TimeoutError` means a live sidecar just hasn't answered yet (`unresponsive`, keeps polling the
  same one instead of spawning).
- `BunRuntime.runMain(..., { disableErrorReporting: true })` — the CLI prints its own clean
  message per outcome and fails with an empty `ReportedFailure` sentinel just to get a non-zero
  exit code; letting the default reporter run too would double-print a stack trace under it.
