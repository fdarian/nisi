/**
 * The local branch a PR's worktree checks out. Namespaced under `nisi/` and
 * keyed by PR number rather than reusing the PR's own `headRef` as-is —
 * `headRef` is the *author's* branch name, and forcing our fetch onto a
 * same-named local branch the user already has (entirely plausible when
 * reviewing your own PR from the repo you authored it in) would silently
 * rewrite their branch pointer out from under them. `headRef` is folded in
 * only for readability in `git branch` output; the PR number alone is what
 * makes this collision-free.
 */
export const worktreeBranchFor = (number: number, headRef: string): string =>
	`nisi/pr-${number}/${headRef}`;

const WORKTREE_BRANCH_PATTERN = /^nisi\/pr-\d+\/(.+)$/;

/** Inverse of {@link worktreeBranchFor}: the PR's own head ref, or `branch` unchanged when it isn't a nisi-managed PR branch. */
export const headRefOfWorktreeBranch = (branch: string): string =>
	WORKTREE_BRANCH_PATTERN.exec(branch)?.[1] ?? branch;
