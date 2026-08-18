# @repo/git

Pure git domain: PR/diff detection and the file-change model consumed by the sidecar. No SQLite,
no oRPC — everything here is `git`/`gh` shelled out to via `effect/unstable/process`, so it's
unit-testable against real temp repos without booting anything. Feeds `packages/sidecar-api`'s
`diff` contract.

- `exec.ts` — the only place that spawns processes. `git`/`gh` helpers plus a strict (fails on
  non-zero exit) and lenient (reports exit code, for "ran and said no" cases like no PR) variant.
- `repo.ts` — repo root / current branch / merge-base / HEAD sha / local default branch, pure
  `git`. `resolveHeadSha`/`resolveMergeBase` both default their ref argument to `HEAD` but accept
  any other ref explicitly — what `diff.ts`'s `headRef` option resolves through. Also owns
  `DiffTarget` and `diffTargetArgs`: the diff's right-hand side (a commit, or the worktree via
  git's own bare commit-vs-worktree form) and its translation to git args — threaded through
  `patch.ts` and `diff.ts` instead of each re-deriving it from a boolean.
- `pull-request.ts` — `resolveReviewTarget`: what a review is *against*. The GitHub half is
  optional — no remote, a host `gh` doesn't know, or an origin GitHub can't resolve all degrade to
  `github: null` and `repo.ts`'s `resolveLocalDefaultBranch`, since nisi reviews local branches, not
  only PRs. Only *not being able to ask* (no `gh`, no auth, no network) fails, as
  `GitHubUnreachable`; see the module for why that split is matched on `gh`'s message rather than
  its exit code.
- `pull-request-checks.ts` — `fetchPullRequestChecks`: `gh pr view <number> --json statusCheckRollup`,
  mapped from GitHub's two check shapes (`CheckRun` for GitHub Actions, `StatusContext` for external
  status integrations) to the 5-state vocabulary `apps/desktop/src/components/pr/ci-status.tsx`'s
  `CiCheckStatus` renders. A field GraphQL declares nullable comes back as that type's zero value
  (`""`/`"0001-01-01T00:00:00Z"`), never JSON `null` or an omitted key — confirmed live against
  several real PRs, not assumed from GitHub's docs.
- `classify.ts` — implementation/test/generated. Test globs are Jest's `testMatch` / Vitest's
  `include` hand-expanded out of extglob syntax into brace alternation, since `Bun.Glob` (used
  here instead of a dependency) doesn't support `?(...)`.
- `blob.ts` — batched `cat-file --batch-check` (keyed by `<ref>:<path>` directly, no `ls-tree`
  path→oid pass) + `cat-file --batch` for reading blob content at a ref without one subprocess per
  file. `readBlobsAtRef` (internal, size-gated) backs `diff.ts`'s content fetch; `readFileContentsAtRef`
  (exported, ungated) is the same batching for a caller that wants every listed path's exact bytes
  at a ref regardless of size — e.g. the sidecar rehashing a handful of reviewed files against HEAD,
  where a rendering-oriented size gate would silently make some of them uncomparable.
- `patch.ts` — combined `git diff` fetch, split client-side on `^diff --git`, with a per-file
  fallback when the split doesn't match the request.
- `hunk.ts` — hunk model + parser.
- `content-diff.ts` — `diffContents`: diffs two arbitrary strings (never real git refs) via
  `git hash-object -w --stdin` + `git diff` on the resulting blobs. What `@repo/review`'s
  reconciliation is built on — a review snapshot isn't a ref, so a ref-based `git diff` can't compare
  it against head. `diffContentsPatch` is its human-facing sibling: same bare-blob mechanism, but with
  real context lines and the header rewritten to name the real path instead of the two blobs' shas —
  what the sidecar uses to serve a `reviewedBaseline → head` patch (`apps/desktop/sidecar/store.ts`'s
  `readFileContents`).
- `change-signal.ts` — `readRepoChangeSignature`: HEAD's sha plus, only when `includeUncommitted` is
  `true`, a content hash (never mtime/size — collides too easily, see the module's doc comment) per
  path `git status --porcelain` reports dirty. `false` (default) skips `status` and hashing
  entirely — the signature is just `headSha`. What the sidecar's live-update poller diffs
  tick-to-tick to detect a session's files changed; the caller (`live-poll.ts`) resolves the flag
  from `@repo/settings` and passes it in, since this package doesn't read settings itself.
- `diff.ts` — orchestrates the above into `getChangedFiles` (cheap, all files, metadata only) and
  `getFileContents` (every requested path's patch + gated content in one pass, so opening N files
  in the diff pane, or gathering a walkthrough's per-turn validation facts, costs a constant handful
  of spawns rather than N times as many — both `apps/desktop/src/lib/pr-data.ts`'s `useFileContents` and
  `apps/desktop/sidecar/walkthrough/context.ts`'s `gatherGenerationContext` call it, there's no
  remaining per-path `getFileContent`). Both default to committed history only
  (`merge-base(baseRef, HEAD)..HEAD`, `includeUncommitted: false`); passing `includeUncommitted:
  true` switches the diff's right-hand side to the worktree — staged, unstaged, and untracked
  changes included too. `getFileContents` resolves `includeUncommitted` once for the whole batch,
  not per requested path — it's a session-wide setting, not a per-file one. Both also take an
  optional `headRef`, diffing `merge-base(baseRef, headRef)..headRef` instead of `..HEAD` — passing
  it forces `includeUncommitted` off regardless of what the caller asked for, since an explicit
  head has no guaranteed relationship to what `repoRoot`'s worktree actually has checked out (see
  `apps/desktop/sidecar/diff-head.ts`'s `resolveDiffHead`, the caller that decides when this applies).
- `worktree.ts` — `openPullRequestWorktree`: create-or-reuse a PR's local worktree, resolution keyed
  off `git worktree list --porcelain` (branch, never a path comparison — see the module's doc
  comment for the full reuse order). `revalidateWorktreePath` is the read-path sibling: given a
  worktree path a caller resolved earlier, cheaply confirms it still exists (`stat`, no git spawn)
  and, only when it doesn't, re-resolves it the same branch-keyed way — recovering from a `git
  worktree move` (or an external tool like `wt`/worktrunk relocating a worktree nisi created) without
  the caller ever re-running the create-or-reuse flow. Fails with `WorktreeRelocationFailed` when
  nothing registered matches the branch either — a worktree actually `git worktree remove`d, not
  just moved. `apps/desktop/sidecar/store.ts`'s `resolveLiveRepoRoot` is the one caller, and also
  where a resolved relocation gets persisted back onto the session row.

## Gotchas

- **`DiffTarget` (`repo.ts`), not a raw boolean, carries "committed vs worktree" through
  `getChangedFiles`/`getFileContents`/`readPatches`.** `includeUncommitted` (default `false`) is
  resolved to a `DiffTarget` once, at the top of each function (once per whole batch in
  `getFileContents`, not per requested path), and threaded as-is from there — the name-status/numstat
  calls, `readPatches`, and which of `gateFromBlob`/`readWorktreeGated` reads the new side all key
  off that same value, so the two modes can't drift apart by being re-interpreted independently
  downstream. `change-signal.ts` takes the same flag but resolves it independently (it has no
  `DiffTarget`/diff to thread it through) — `false` skips `status`/hashing outright rather than
  reading the worktree and discarding the result.
- **A rename's pathspec must include the old path.** `git diff -M <base> -- <newpath>` alone
  can't detect the rename — the pathspec hides the deletion half from git's rename pairing, so it
  renders as a plain add. Both `readPatches` (via `pathspecFor`) and `getFileContents`' status
  lookup work around this; `getFileContents` does it by not pathspec-restricting the name-status
  call at all rather than needing to know the rename ahead of time. Caught by a real test
  (`test/patch.test.ts`) — don't reintroduce a single-path pathspec on a rename-sensitive call.
- **`effect/unstable/process`'s barrel re-exports namespaces, not classes.** `ChildProcessSpawner`
  imported from `effect/unstable/process` is the *module*; the service tag is
  `ChildProcessSpawner.ChildProcessSpawner`.
- **`Effect.catchAll` doesn't exist in this Effect version** — use `Effect.orElseSucceed` (or
  `catchTag`/`catchCause` for narrower cases).
- Size gate (`diff.ts`) mirrors codiff: ≤1MB auto-render, ≤2MB load-on-demand (needs
  `getFileContents`' per-path `force` option, since without it that tier could never be loaded),
  above that patch-only always.
- Binary detection unions two signals: a NUL byte in decoded content, and the patch matching
  `Binary files ... differ` anchored to line start — either can be the only one available
  depending on which path (bulk metadata vs. single-file fetch) computed it.
- `diffContents` writes loose objects into the *caller's* repo (`hash-object -w`) — `git diff` on a
  bare object id can only read content that actually exists in the odb. Content-addressed, so
  re-diffing the same pair (the common case) never grows the odb past one object per distinct
  content seen, but it does mean this can't run against a repo you don't want written to.
