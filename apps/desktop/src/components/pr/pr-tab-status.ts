import type { PullRequestCheck, PullRequestMergeStatus } from "#/lib/pr-data";

/**
 * What the PR tab badge's icon (`PrTabIcon`, `pr-tab-strip.tsx`) shows once
 * suspension is ruled out — suspension is a tab-strip concept with no
 * `mergeStatus`/`checks` input of its own, so it stays the caller's
 * concern rather than a fifth member of this union.
 */
export type PrTabStatus = "merged" | "ci-running" | "ready" | "default";

/**
 * Pure precedence table behind the badge: merged outranks everything (a
 * merged PR can still report a stray `"running"` check from a post-merge
 * workflow, and that must not un-merge the icon), CI in flight outranks
 * "ready to merge" (a green tab whose checks are still running would read
 * as safe to merge when it isn't), and anything else — failing, blocked,
 * conflicting, draft, closed, or the query still loading — falls through to
 * `"default"` on purpose (see `pr-tab-strip.tsx`'s callers for why those
 * states don't get their own color).
 *
 * Kept I/O-free and separate from `pr-tab-strip.tsx` so this branch table —
 * the actual risk surface for the tab badge — is unit-testable without
 * mounting the strip or its query hooks.
 */
export function derivePrTabStatus(
	mergeStatus: PullRequestMergeStatus | undefined,
	checks: readonly PullRequestCheck[] | undefined,
): PrTabStatus {
	if (mergeStatus?.state === "MERGED") return "merged";

	if (checks?.some((check) => check.status === "running") === true) {
		return "ci-running";
	}

	if (
		mergeStatus?.mergeable === "MERGEABLE" &&
		mergeStatus.mergeStateStatus === "CLEAN"
	) {
		return "ready";
	}

	return "default";
}
