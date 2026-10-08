import { commitExists, fetchBaseRef } from "@repo/git";
import { Effect } from "effect";

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
 * that branch's history). If it still isn't there, the session's `baseRef` is
 * used rather than failing the whole diff.
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
		yield* fetchBaseRef(repoRoot, baseRef).pipe(
			Effect.catchTag("GitCommandError", (error) =>
				Effect.logWarning("Could not fetch the base of a merged PR", {
					repoRoot,
					baseRef,
					error,
				}),
			),
		);
		if (yield* commitExists(repoRoot, tip)) return tip;
		yield* Effect.logWarning(
			"Merged PR's base commit is not available; using the live base",
			{ repoRoot, baseRef, tip },
		);
		return baseRef;
	});
