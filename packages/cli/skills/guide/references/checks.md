# Checks

`<Checks />` lists recorded runs, never prose. Record each one with `nisi guide check` rather than running the command bare and describing the result:

```sh
nisi guide check "Type check and lint" -- pnpm turbo run check:type check:lint
```

The command runs in the repo root, streams its output, exits with the command's exit code, and writes `.nisi/guide/checks/<slug>.json`: title, command, exit code, duration, the commit it ran at, whether the working tree had uncommitted changes, and the last 40 lines of output. The tab shows a pass or fail mark, the command, the short commit, a muted "with uncommitted changes" note when the tree was dirty, and the output on click.

## Which commands

Record the repo's standard check commands: whatever its package scripts, CI config, or AGENTS.md / CLAUDE.md say a change must pass (type check, lint, tests, build). If the default test script doesn't cover the tests you touched or added (a different package, a filtered run, a separate runner), record an explicit command that does, for example `nisi guide check "Parser tests" -- "cd packages/parser && bun test"`. A green default script that never ran your tests vouches for nothing.

- **The command** is either an argv after `--` (`nisi guide check "Type check" -- pnpm turbo run check:type`; run directly) or one quoted shell line for `cd` and `&&`: `nisi guide check "Desktop tests" -- "cd apps/desktop && bun test"`. The title is always one argument, so quote it.
- **No app needed.** Unlike `validate` and `render`, `check` never talks to the sidecar.
- **Read-only commands only.** `nisi guide check` warns, without stopping, when the command looks like it writes (`--write`, `--fix`, `-w`, `format`): a check that rewrites files records a pass for code it just changed.
- **A cached pass is a pass.** A turbo cache hit (`FULL TURBO`, "cache hit, replaying logs") means the same inputs already passed, so the run records exit 0 exactly as a fresh one would.
- **Same title, same record.** Re-running with the same title replaces the earlier run.
- **Run checks after your last code change.** Committing first isn't required. If you aren't allowed to commit, or haven't yet, the run records the HEAD sha plus `dirty: true` and the Checks row says "with uncommitted changes". Changes under `.nisi/` don't count as uncommitted.
- **Stale.** A run recorded at a commit other than the worktree's HEAD is marked stale, and `nisi guide validate` reports it. This happens when you commit after the run: re-run the checks, then validate.
- **A failing run is still a record.** Don't hide it; a reviewer should see it. Fix the code and re-run, or say what's wrong in a `Needs you` item.

## What counts as a check

Something a command can say yes or no to: type check, lint, a test suite, a build, a script that exercises the change. Record the commands you ran to convince yourself the change works, not every command you ran.

A repo without tests still gets checks: record a behaviour probe, a small command that exercises the change and exits non-zero when it is wrong. Put anything longer than a line or two in a script file (`.nisi/guide/probe.sh`, or the repo's own scripts folder if the probe is worth keeping) and record `nisi guide check "Parser handles empty input" -- bash .nisi/guide/probe.sh`. A giant inline command is hard to read in the Checks row, which clamps it to two lines.

## Skipped

What you deliberately didn't run goes inside `<Checks>` as `<Skipped title="…">reason</Skipped>`, so the reader sees the gap instead of assuming coverage:

```mdx
<Checks>
  <Skipped title="Run against real GitHub">Tests use a fake `gh`.</Skipped>
</Checks>
```

Don't use `Skipped` for work you could have done; do it. Use it for what needs something you lack (a signed build, production credentials, a human's eyes), and put the human's part in `Needs you`.

## In the nisi repo

The standard checks are `pnpm turbo run check:type check:lint` (type check and lint) and `bun test` from inside each package or app you touched (`cd packages/<name> && bun test`; in `apps/desktop`, scope it, for example `bun test sidecar src/features/guide`). There is no repo-wide test task, so a root-level run covers none of them.
