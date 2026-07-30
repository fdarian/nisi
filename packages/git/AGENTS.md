# @repo/git

Pure git domain: PR/diff detection and the file-change model consumed by the sidecar. No SQLite,
no oRPC — everything here is `git`/`gh` shelled out to via `effect/unstable/process`, so it's
unit-testable against real temp repos without booting anything. Feeds `packages/sidecar-api`'s
`diff` contract.

- `exec.ts` — the only place that spawns processes. `git`/`gh` helpers plus a strict (fails on
  non-zero exit) and lenient (reports exit code, for "ran and said no" cases like no PR) variant.
- `repo.ts` — repo root / current branch / merge-base / HEAD sha / local default branch, pure
  `git`. Also owns `DiffTarget` and `diffTargetArgs`: the diff's right-hand side (a commit, or the
  worktree via git's own bare commit-vs-worktree form) and its translation to git args — threaded
  through `patch.ts` and `diff.ts` instead of each re-deriving it from a boolean.
- `pull-request.ts` — `resolveReviewTarget`: what a review is *against*. The GitHub half is
  optional — no remote, a host `gh` doesn't know, or an origin GitHub can't resolve all degrade to
  `github: null` and `repo.ts`'s `resolveLocalDefaultBranch`, since nisi reviews local branches, not
  only PRs. Only *not being able to ask* (no `gh`, no auth, no network) fails, as
  `GitHubUnreachable`; see the module for why that split is matched on `gh`'s message rather than
  its exit code.
- `classify.ts` — implementation/test/generated. Test globs are Jest's `testMatch` / Vitest's
  `include` hand-expanded out of extglob syntax into brace alternation, since `Bun.Glob` (used
  here instead of a dependency) doesn't support `?(...)`.
- `blob.ts` — batched `ls-tree` + `cat-file --batch-check` + `cat-file --batch` for reading blob
  content at a ref without one subprocess per file. `readBlobsAtRef` (internal, size-gated) backs
  `diff.ts`'s content fetch; `readFileContentsAtRef` (exported, ungated) is the same batching for a
  caller that wants every listed path's exact bytes at a ref regardless of size — e.g. the sidecar
  rehashing a handful of reviewed files against HEAD, where a rendering-oriented size gate would
  silently make some of them uncomparable.
- `patch.ts` — combined `git diff` fetch, split client-side on `^diff --git`, with a per-file
  fallback when the split doesn't match the request.
- `hunk.ts` — hunk model + parser.
- `content-diff.ts` — `diffContents`: diffs two arbitrary strings (never real git refs) via
  `git hash-object -w --stdin` + `git diff` on the resulting blobs. What `@repo/review`'s
  reconciliation is built on — a review snapshot isn't a ref, so a ref-based `git diff` can't compare
  it against head.
- `change-signal.ts` — `readRepoChangeSignature`: a cheap mtime+size (never content) signature per path
  from `git status --porcelain`, plus HEAD's sha. What the sidecar's live-update poller diffs
  tick-to-tick to detect a session's files changed without hashing content on every tick.
- `diff.ts` — orchestrates the above into `getChangedFiles` (cheap, all files, metadata only) and
  `getFileContent` (one file, patch + gated content). Both default to committed history only
  (`merge-base(baseRef, HEAD)..HEAD`, `includeUncommitted: false`); passing `includeUncommitted:
  true` switches the diff's right-hand side to the worktree — staged, unstaged, and untracked
  changes included too.

## Gotchas

- **`DiffTarget` (`repo.ts`), not a raw boolean, carries "committed vs worktree" through
  `getChangedFiles`/`getFileContent`/`readPatches`.** `includeUncommitted` (default `false`) is
  resolved to a `DiffTarget` once, at the top of each function, and threaded as-is from there — the
  name-status/numstat calls, `readPatches`, and which of `readGatedBlob`/`readWorktreeGated` reads
  the new side all key off that same value, so the two modes can't drift apart by being
  re-interpreted independently downstream. `change-signal.ts` is the one module that always reads
  live worktree state (mtime/size, never content), regardless of this flag.
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
  `getFileContent`'s `force` option, since without it that tier could never be loaded), above that
  patch-only always.
- Binary detection unions two signals: a NUL byte in decoded content, and the patch matching
  `Binary files ... differ` anchored to line start — either can be the only one available
  depending on which path (bulk metadata vs. single-file fetch) computed it.
- `diffContents` writes loose objects into the *caller's* repo (`hash-object -w`) — `git diff` on a
  bare object id can only read content that actually exists in the odb. Content-addressed, so
  re-diffing the same pair (the common case) never grows the odb past one object per distinct
  content seen, but it does mean this can't run against a repo you don't want written to.
