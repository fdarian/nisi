import { oc } from "@orpc/contract";
import { Schema } from "effect";
import { PullRequestCheckStatus } from "./pull-requests.ts";

/**
 * One CI check on a single commit, for the Overview tab's per-commit list —
 * mirrors `@repo/git`'s `OverviewCommitCheck`. Deliberately not
 * `PullRequestCheck` (`pull-requests.ts`) reused wholesale: that shape's
 * `durationMs`/`workflowName` back the PR header's `CiStatus` ring, which
 * this tab has no equivalent of. `status` is the one piece that *is*
 * reusable as-is — the same 5-state vocabulary either way — so it's imported
 * rather than redeclared.
 */
export const OverviewCheck = Schema.Struct({
	name: Schema.String,
	status: PullRequestCheckStatus,
	detail: Schema.optional(Schema.String),
	detailsUrl: Schema.optional(Schema.String),
});
export type OverviewCheck = Schema.Schema.Type<typeof OverviewCheck>;

/**
 * One commit in the Overview tab's list — mirrors `@repo/git`'s
 * `OverviewCommit`. `authorLogin`/`url`/`checks` are all `null` for a
 * branch/diff session: a plain `git log` has no GitHub identity or CI data
 * to attach, unlike a PR session's GraphQL-backed read.
 */
export const OverviewCommit = Schema.Struct({
	sha: Schema.String,
	shortSha: Schema.String,
	headline: Schema.String,
	/** Full commit body after the headline — `null`, not `""`, when the commit has none. */
	body: Schema.NullOr(Schema.String),
	authorName: Schema.String,
	/** `null` when GitHub can't attribute the commit to an account. */
	authorLogin: Schema.NullOr(Schema.String),
	/** ISO 8601. */
	committedDate: Schema.String,
	/** GitHub commit URL — `null` in branch mode. */
	url: Schema.NullOr(Schema.String),
	/** `null` when GitHub reports no CI rollup at all for this commit; `[]` for a rollup with zero contexts. Always `null` in branch mode. */
	checks: Schema.NullOr(Schema.Array(OverviewCheck)),
});
export type OverviewCommit = Schema.Schema.Type<typeof OverviewCommit>;

/** The PR description half of `overview.get`'s result — `null` for a branch/diff session, which has no PR to describe. */
export const OverviewDescription = Schema.Struct({
	authorLogin: Schema.String,
	body: Schema.NullOr(Schema.String),
});
export type OverviewDescription = Schema.Schema.Type<
	typeof OverviewDescription
>;

export const OverviewResult = Schema.Struct({
	description: Schema.NullOr(OverviewDescription),
	/** Oldest-first, matching GitHub's own PR commits tab. */
	commits: Schema.Array(OverviewCommit),
});
export type OverviewResult = Schema.Schema.Type<typeof OverviewResult>;

/**
 * `get`'s input is `repoRoot` plus a discriminated union on `kind` — a PR
 * session (GitHub identity, resolved through `@repo/git`'s
 * `fetchPullRequestOverview`) or a branch/diff session (just the two refs
 * `@repo/git`'s `fetchBranchCommits` diffs, no GitHub involved at all). Not
 * nested under a `target` field the way `sessions.SessionTarget` is — the
 * Overview tab already has a session's resolved `kind`/refs/PR identity in
 * hand from `sessions.list`, so there's nothing else this input needs to
 * carry alongside them.
 */
export const OverviewInput = Schema.Union([
	Schema.Struct({
		repoRoot: Schema.String,
		kind: Schema.Literal("pr"),
		owner: Schema.String,
		repo: Schema.String,
		number: Schema.Number,
	}),
	Schema.Struct({
		repoRoot: Schema.String,
		kind: Schema.Literal("branch"),
		baseRef: Schema.String,
		headRef: Schema.String,
	}),
]);
export type OverviewInput = Schema.Schema.Type<typeof OverviewInput>;

/**
 * Backs the Overview tab: a PR session's description plus every commit
 * (with CI status, PR mode only) or, for a branch/diff session, just the
 * commit list. Error codes mirror `pullRequests.checks`'s PR-scoped subset —
 * `@repo/git`'s `fetchPullRequestOverview` classifies failures the same way
 * (`gh` not authenticated, GitHub API rate-limited, or the PR itself
 * couldn't be resolved) since both are `gh`-backed GraphQL/REST reads
 * against the same PR. Branch mode's `@repo/git`'s `fetchBranchCommits` is
 * pure local `git`, so only `SERVICE_UNAVAILABLE` (a `git` command failing
 * to run at all) ever applies to it.
 */
export const overviewContract = {
	get: oc.input(OverviewInput).output(OverviewResult).errors({
		GH_NOT_AUTHENTICATED: {},
		TOO_MANY_REQUESTS: {},
		SERVICE_UNAVAILABLE: {},
		NOT_FOUND: {},
	}),
};
