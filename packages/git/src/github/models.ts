import { Schema } from "effect";
import type {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	PullRequestNotFound,
} from "../errors.ts";

/**
 * The 5-state vocabulary `apps/desktop/src/features/pull-request/header/ci-status.tsx`'s
 * `CiCheckStatus` renders, computed here from GitHub's two check shapes —
 * this is domain knowledge (what "failing" means across a GitHub Actions run
 * vs. an external status integration), not a wire concern, so it's owned by
 * this module rather than left for the sidecar or frontend to re-derive.
 */
export type PullRequestCheckStatus =
	| "passing"
	| "failing"
	| "running"
	| "pending"
	| "skipped";

export type FetchPullRequestChecksInput = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

export type PullRequestCheck = {
	name: string;
	status: PullRequestCheckStatus;
	/**
	 * Elapsed run time in milliseconds, only when GitHub reports a real
	 * `completedAt` for a `CheckRun` — `undefined` for anything still in
	 * flight, or reported by an external `StatusContext`, which carries no
	 * duration at all. Left as a number, not a formatted string — how a
	 * duration reads is a presentation concern for the frontend
	 * (`apps/desktop/src/features/pull-request/header/pr-ci-status.tsx`), not something this
	 * package should be minting English text for.
	 */
	durationMs?: number;
	detailsUrl?: string;
	/**
	 * The Actions workflow a `CheckRun` belongs to (e.g. `"CI"`) — absent for a
	 * `StatusContext`, which has no workflow concept and whose `name` (its
	 * `context`) is already unique by definition. Carried raw, including a
	 * possible `""` (a `CheckRun` from a non-Actions GitHub App check, which
	 * has no workflow either) — callers that qualify an ambiguous `name` with
	 * this need to treat `""` the same as absent, not print a bare `" / "`.
	 * `name` alone is *not* guaranteed unique: two different workflows can
	 * both define a job called `test`, and `gh` reports the bare job name —
	 * disambiguating is `pr-ci-status.tsx`'s job, once it can see every check
	 * in the set at once.
	 */
	workflowName?: string;
};

/**
 * One CI check on a commit, for the Overview tab's per-commit list.
 * Deliberately not `PullRequestCheck` (`pull-request-checks.ts`) reused
 * wholesale — that shape carries `durationMs`/`workflowName`, facts the PR
 * header's `CiStatus` ring needs but a per-commit row here doesn't. `detail`
 * stands in for `workflowName` (a `CheckRun`'s Actions workflow name, when
 * there is one — never set for a `StatusContext`) since this tab has no
 * per-check breakdown to disambiguate a bare duration the way
 * `pr-ci-status.tsx` does; formatting a duration into English is still a
 * presentation concern this package doesn't take on. `status` reuses the
 * exact same 5-state vocabulary as `PullRequestCheck`.
 */
export type OverviewCommitCheck = {
	readonly name: string;
	readonly status: PullRequestCheckStatus;
	readonly detail?: string;
	readonly detailsUrl?: string;
};

/**
 * One commit in the Overview tab's list, PR mode and branch mode alike —
 * `commit-log.ts`'s branch-mode reader produces the same shape with
 * `authorLogin`/`url` always `null` and `checks` always `null` (no GitHub
 * identity or CI data for a commit that was only ever read off local `git
 * log`).
 */
export type OverviewCommit = {
	readonly sha: string;
	readonly shortSha: string;
	readonly headline: string;
	/** Full commit body after the headline — `null`, not `""`, when the commit has none. */
	readonly body: string | null;
	readonly authorName: string;
	/** `null` when GitHub can't attribute the commit to an account (no matching email, or a since-deleted one). */
	readonly authorLogin: string | null;
	readonly committedDate: string;
	/** `null` in branch mode — there's no GitHub commit page for a ref that was never pushed as (or isn't part of) a PR. */
	readonly url: string | null;
	/** `null` when GitHub reports no CI rollup at all for this commit; `[]` for a rollup with zero contexts. Always `null` in branch mode. */
	readonly checks: ReadonlyArray<OverviewCommitCheck> | null;
};

export type PullRequestOverview = {
	readonly description: {
		readonly authorLogin: string;
		readonly body: string | null;
	};
	readonly commits: ReadonlyArray<OverviewCommit>;
};

export type FetchPullRequestOverviewInput = {
	readonly repoRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};

export type PullRequestStackEntry = {
	readonly position: number;
	readonly number: number;
	readonly title: string;
	readonly headRefName: string;
	readonly baseRefName: string;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly isDraft: boolean;
};

export type PullRequestStack = {
	readonly number: number;
	readonly size: number;
	readonly baseRefName: string;
	readonly position: number;
	readonly entries: ReadonlyArray<PullRequestStackEntry>;
};

export type FetchPullRequestStackInput = {
	readonly repoRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};

export type PullRequestStackError =
	| GhOutputDecodeError
	| GhNotAuthenticated
	| GhRateLimited
	| PullRequestNotFound;

export const MergeabilityView = Schema.Struct({
	state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
	mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
	mergeStateStatus: Schema.Literals([
		"BEHIND",
		"BLOCKED",
		"CLEAN",
		"DIRTY",
		"DRAFT",
		"HAS_HOOKS",
		"UNKNOWN",
		"UNSTABLE",
	]),
	isDraft: Schema.Boolean,
});

export type PullRequestMergeability = Schema.Schema.Type<
	typeof MergeabilityView
>;

export type MergeMethod = "merge" | "squash" | "rebase";
