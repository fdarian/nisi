import type {
	GitCommandError,
	PullRequestRefNotFound,
	RepoPathNotAGitRepo,
	RepoPathNotFound,
} from "@repo/git";
import {
	commitExists,
	fetchPullRequestHeadSha,
	headDescendsFrom,
	resolveCurrentBranch,
	resolveHeadSha,
	resolveMainCloneRoot,
} from "@repo/git";
import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

/**
 * `sessions.open`'s `target: { kind: "branch", headRef }` (the range-spelling
 * form of `nisi diff <base>..<head>`, see `packages/cli`) named a ref `git`
 * couldn't resolve — typically a typo. Mirrors `store.ts`'s `InvalidBaseRef`
 * — kept as its own tag rather than reusing it so a typo on either side of
 * the range is attributed to the ref that was actually bad.
 */
export class InvalidHeadRef extends Schema.TaggedError<InvalidHeadRef>()(
	"InvalidHeadRef",
	{
		repoRoot: Schema.String,
		headRef: Schema.String,
		stderr: Schema.String,
	},
) {}

/**
 * Fails with `InvalidHeadRef` when `headRef` doesn't resolve to a real
 * commit in `repoRoot` — run explicitly by `store.ts`'s `resolveSessionTarget`
 * so a typo'd `<head>` fails the request before a session is ever persisted,
 * the same reasoning `InvalidBaseRef`'s own validation already documents.
 */
export const validateHeadRef = (
	repoRoot: string,
	headRef: string,
): Effect.Effect<
	void,
	InvalidHeadRef,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	resolveHeadSha(repoRoot, headRef).pipe(
		Effect.asVoid,
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.fail(
				new InvalidHeadRef({ repoRoot, headRef, stderr: cause.stderr }),
			),
		),
	);

/**
 * What every git call against a session should treat as its head, plus
 * whether it's safe to overlay `repoRoot`'s worktree on top of it at all —
 * `headRef` is `undefined` exactly when `worktreeEligible` is `true` (the
 * `@repo/git` default of "current checkout" already means the same thing),
 * and otherwise what to diff instead: the session's own `headRef` string, or
 * a PR head commit sha.
 */
export type DiffHead = {
	readonly headRef: string | undefined;
	readonly worktreeEligible: boolean;
};

/**
 * What {@link resolveDiffHead} needs to know about a session's PR. `headSha`
 * is the PR's head commit as last seen from GitHub (`Store`'s in-memory
 * cache, fed by the merge-status watch), `undefined` until the first reading.
 */
export type DiffHeadPullRequest = {
	readonly number: number;
	readonly headSha: string | undefined;
	readonly merged: boolean;
};

/**
 * Makes `headSha` resolvable in `repoRoot` for diffing. A commit already in
 * the (shared) object store is used as-is. Otherwise `refs/pull/<n>/head` is
 * fetched from the main clone's `origin` — the one ref GitHub publishes for
 * every PR including fork PRs, and it lands in `FETCH_HEAD` only, so no ref is
 * created. That fetch can only return the PR's *current* tip: when `headSha`
 * is a head the PR has since moved past (a force-push), the tip is the
 * commit to diff.
 */
const ensurePullRequestHeadCommit = (
	repoRoot: string,
	number: number,
	headSha: string,
) =>
	Effect.gen(function* () {
		if (yield* commitExists(repoRoot, headSha)) return headSha;
		const mainCloneRoot = yield* resolveMainCloneRoot(repoRoot);
		const tip = yield* fetchPullRequestHeadSha(mainCloneRoot, number);
		return (yield* commitExists(repoRoot, headSha)) ? headSha : tip;
	});

/**
 * Decides {@link DiffHead} for a session — the single place that answers
 * "which ref is this session's head right now, and is the worktree safe to
 * overlay on it." Shared by every read (`listChangedFiles`/`readFileContents`)
 * and write (`setFileViewed`/`setRangeViewed`) path in `store.ts` that
 * touches a session's files, so the two can never disagree about which
 * commit "head" means at a given moment — before this was split out, only
 * the read paths consulted it, which is exactly how a write could silently
 * snapshot the wrong branch's content (see the git history for the fix this
 * accompanies).
 *
 * A PR-backed session's worktree is eligible only while its `HEAD` is the
 * PR's head commit or a descendant of it — whatever branch, or detached
 * `HEAD`, the worktree is on. Claude Code reuses worktrees, so a path that
 * once held this PR can have moved on to an unrelated one; diffing "whatever
 * `HEAD` is now" would then show another PR's changes. A descendant counts
 * so unpushed local commits on top of the PR stay visible. When the worktree
 * isn't eligible the session diffs the PR head commit directly (a raw sha, no
 * ref created — see {@link ensurePullRequestHeadCommit} for how it's made
 * available), with uncommitted changes off since they belong to whatever the
 * worktree is doing now. A merged PR never uses the worktree, even when its
 * `HEAD` descends from the PR head (a checkout of `main` after the merge
 * does): the diff is the PR's own range, not whatever the worktree has gained
 * since. Until the PR's head is known (`headSha` undefined)
 * the worktree is trusted, as it was before this check existed. The PR's
 * `headRef` branch name is never passed to git: in a nisi worktree it isn't
 * guaranteed to resolve at all (nisi checks the PR out onto its own
 * `nisi/pr-<n>/<headRef>` branch).
 *
 * Every other session compares `headRef` against what's actually checked
 * out right now (`resolveCurrentBranch`) — re-checked on every call, never
 * decided once and cached, so a session drifts in and out of
 * worktree-eligibility as the caller checks different branches out rather
 * than staying pinned to whatever was true when the session opened. This
 * covers both directions: an explicit, never-checked-out head (`nisi diff
 * <base>..<head>`) starts ineligible and self-heals the moment the caller
 * checks it out; an ordinary session (`headRef` equal to the checkout at
 * open time) goes ineligible the moment the caller checks out something
 * else, and every subsequent read/write must follow that — not keep
 * treating the worktree as if it still belonged to this session.
 */
export const resolveDiffHead = (
	repoRoot: string,
	headRef: string,
	pullRequest: DiffHeadPullRequest | null,
): Effect.Effect<
	DiffHead,
	| GitCommandError
	| PullRequestRefNotFound
	| RepoPathNotFound
	| RepoPathNotAGitRepo,
	ChildProcessSpawner.ChildProcessSpawner
> => {
	if (pullRequest === null)
		return resolveCurrentBranch(repoRoot).pipe(
			Effect.map((currentBranch) => {
				const worktreeEligible = currentBranch === headRef;
				return {
					headRef: worktreeEligible ? undefined : headRef,
					worktreeEligible,
				};
			}),
		);
	const headSha = pullRequest.headSha;
	if (headSha === undefined)
		return Effect.succeed({ headRef: undefined, worktreeEligible: true });
	return Effect.gen(function* () {
		if (!pullRequest.merged && (yield* headDescendsFrom(repoRoot, headSha)))
			return { headRef: undefined, worktreeEligible: true };
		return {
			headRef: yield* ensurePullRequestHeadCommit(
				repoRoot,
				pullRequest.number,
				headSha,
			),
			worktreeEligible: false,
		};
	});
};
