import { commitExists, fetchBaseRef } from "@repo/git";
import { Effect, Schema } from "effect";

/**
 * A merged PR's `baseRefOid` isn't in `repoRoot` even after fetching its base
 * branch. Failing is deliberate: falling back to the live `origin/<base>` would
 * quietly show the empty diff a true merge commit produces.
 */
export class MergedPullRequestBaseUnavailable extends Schema.TaggedError<MergedPullRequestBaseUnavailable>()(
	"MergedPullRequestBaseUnavailable",
	{
		repoRoot: Schema.String,
		baseRef: Schema.String,
		baseSha: Schema.String,
	},
) {}

/** What GitHub last reported about a session's PR that decides its diff base. */
export type DiffBasePullRequest = {
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly baseSha: string;
};

/**
 * The commit a merged PR's base is pinned to, `undefined` while the live
 * `origin/<base>` is the right tip. Cheap and pure, so it also answers "did
 * the base selection change" when comparing two readings of the PR.
 */
export const pinnedBaseTip = (
	pullRequest: DiffBasePullRequest | undefined,
): string | undefined =>
	pullRequest?.state === "MERGED" ? pullRequest.baseSha : undefined;

/**
 * The `baseRef` every diff computation for a session passes to `@repo/git`:
 * the one place that picks the base, so the file list, per-file contents and
 * reviewed-state reconciliation can never disagree about it.
 *
 * The diff base is `merge-base(base tip, head)`. With a true merge commit the
 * PR head becomes an ancestor of `origin/<base>`, so that merge-base is the
 * head itself and the diff goes empty. Once GitHub reports the PR MERGED, the
 * base tip is therefore pinned to the PR's `baseRefOid` — main as it stood
 * before the merge — which yields the same diff squash and rebase merges
 * already show. `@repo/git` accepts a raw sha as a base, so no ref is created.
 * Every other case keeps the session's own `baseRef`.
 *
 * A pinned commit that isn't local is fetched via the base branch (it's on
 * that branch's history); if it's still missing the diff fails with
 * `MergedPullRequestBaseUnavailable`.
 */
export const resolveDiffBase = (
	repoRoot: string,
	baseRef: string,
	pullRequest: DiffBasePullRequest | undefined,
) =>
	Effect.gen(function* () {
		const tip = pinnedBaseTip(pullRequest);
		if (tip === undefined) return baseRef;
		if (yield* commitExists(repoRoot, tip)) return tip;
		yield* fetchBaseRef(repoRoot, baseRef);
		if (yield* commitExists(repoRoot, tip)) return tip;
		return yield* new MergedPullRequestBaseUnavailable({
			repoRoot,
			baseRef,
			baseSha: tip,
		});
	});
