# Checks

`<Checks />` lists recorded runs, never prose. Record each one with `check.ts` rather than running the command bare and describing the result:

```sh
bun .claude/skills/nisi-guide/scripts/check.ts "Type check and lint" -- pnpm turbo run check:type check:lint
```

The script runs the command in the repo root, streams its output, exits with the command's exit code, and writes `.nisi/guide/checks/<slug>.json`: title, command, exit code, duration, the commit it ran at, and the last 40 lines of output. The tab shows a pass or fail mark, the command, the short commit, and the output on click.

- **The command** is either an argv after `--` (`check.ts "Type check" -- pnpm turbo run check:type`; run directly, the title needs no quoting) or one quoted shell line for `cd` and `&&`: `check.ts "Desktop tests" -- "cd apps/desktop && bun test"`.
- **Read-only commands only.** `check.ts` warns, without stopping, when the command looks like it writes (`--write`, `--fix`, `-w`, `format`): a check that rewrites files records a pass for code it just changed.
- **A cached pass is a pass.** A turbo cache hit (`FULL TURBO`, "cache hit, replaying logs") means the same inputs already passed, so the run records exit 0 exactly as a fresh one would.
- **Same title, same record.** Re-running with the same title replaces the earlier run.
- **Stale.** A run recorded at a commit other than the worktree's HEAD is marked stale, and `validate.ts` reports it. Commit first, then run your checks, then validate.
- **A failing run is still a record.** Don't hide it; a reviewer should see it. Fix the code and re-run, or say what's wrong in a `Needs you` item.

## What counts as a check

Something a command can say yes or no to: type check, lint, a test suite, a build, a script that exercises the change. Record the commands you ran to convince yourself the change works, not every command you ran.

## Skipped

What you deliberately didn't run goes inside `<Checks>` as `<Skipped title="…">reason</Skipped>`, so the reader sees the gap instead of assuming coverage:

```mdx
<Checks>
  <Skipped title="Run against real GitHub">Tests use a fake `gh`.</Skipped>
</Checks>
```

Don't use `Skipped` for work you could have done; do it. Use it for what needs something you lack (a signed build, production credentials, a human's eyes), and put the human's part in `Needs you`.
