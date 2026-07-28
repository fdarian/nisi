# @repo/git

Pure git domain: PR/diff detection and the file-change model consumed by the sidecar. No SQLite,
no oRPC — everything here is `git`/`gh` shelled out to via `effect/unstable/process`, so it's
unit-testable against real temp repos without booting anything. See `PLAN.md` (root) for the
Phase 1 contract this feeds.

- `exec.ts` — the only place that spawns processes. `git`/`gh` helpers plus a strict (fails on
  non-zero exit) and lenient (reports exit code, for "ran and said no" cases like no PR) variant.
- `repo.ts` — repo root / current branch / merge-base, pure `git`.
- `pull-request.ts` — `gh`-based PR + repo-identity resolution. `gh pr view` exiting non-zero is
  the expected no-PR case, not an error.
- `classify.ts` — implementation/test/generated. Test globs are Jest's `testMatch` / Vitest's
  `include` hand-expanded out of extglob syntax into brace alternation, since `Bun.Glob` (used
  here instead of a dependency) doesn't support `?(...)`.
- `blob.ts` — batched `ls-tree` + `cat-file --batch-check` + `cat-file --batch` for reading blob
  content at a ref without one subprocess per file.
- `patch.ts` — combined `git diff` fetch, split client-side on `^diff --git`, with a per-file
  fallback when the split doesn't match the request.
- `hunk.ts` — hunk model + parser, for Phase 2's reconciliation.
- `diff.ts` — orchestrates the above into `getChangedFiles` (cheap, all files, metadata only) and
  `getFileContent` (one file, patch + gated content).

## Gotchas

- **A rename's pathspec must include the old path.** `git diff -M <base> -- <newpath>` alone
  can't detect the rename — the pathspec hides the deletion half from git's rename pairing, so it
  renders as a plain add. Both `readPatches` (via `pathspecFor`) and `getFileContent`'s status
  lookup work around this; `getFileContent` does it by not pathspec-restricting the name-status
  call at all rather than needing to know the rename ahead of time. Caught by a real test
  (`test/patch.test.ts`) — don't reintroduce a single-path pathspec on a rename-sensitive call.
- **`effect/unstable/process`'s barrel re-exports namespaces, not classes.** `ChildProcessSpawner`
  imported from `effect/unstable/process` is the *module*; the service tag is
  `ChildProcessSpawner.ChildProcessSpawner`.
- **`Effect.catchAll` doesn't exist in this Effect version** — use `Effect.orElseSucceed` (or
  `catchTag`/`catchCause` for narrower cases).
- Size gate (`diff.ts`) mirrors codiff: ≤1MB auto-render, ≤2MB load-on-demand (needs
  `getFileContent`'s `force` option — an addition beyond PLAN.md's contract sketch, since without
  it that tier could never be loaded), above that patch-only always.
- Binary detection unions two signals: a NUL byte in decoded content, and the patch matching
  `Binary files ... differ` anchored to line start — either can be the only one available
  depending on which path (bulk metadata vs. single-file fetch) computed it.
