import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	type GitCommandError,
	type PullRequestChecksError,
	PullRequestNotFound,
} from "./errors.ts";
import { ghResult } from "./exec.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";
import {
	type CheckRunView,
	type PullRequestCheckStatus,
	type StatusContextView,
	toPullRequestCheck,
} from "./pull-request-checks.ts";

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

/**
 * The exact `CheckRun`/`StatusContext` node shape this module asks GraphQL
 * for — a raw response, so nullable fields decode as real JSON `null` (unlike
 * `gh pr view --json statusCheckRollup`'s Go-zero-value flattening that
 * `pull-request-checks.ts` documents). `toCheckRunView`/`toStatusContextView`
 * below translate a decoded node into the zero-value convention
 * `toPullRequestCheck` (imported from that module) already expects, so this
 * doesn't need a second mapper — only a second *shape*.
 */
const GraphQLCheckRunNode = Schema.Struct({
	__typename: Schema.Literal("CheckRun"),
	name: Schema.String,
	status: Schema.Literals([
		"REQUESTED",
		"QUEUED",
		"WAITING",
		"PENDING",
		"IN_PROGRESS",
		"COMPLETED",
	]),
	conclusion: Schema.NullOr(
		Schema.Literals([
			"SUCCESS",
			"FAILURE",
			"NEUTRAL",
			"CANCELLED",
			"SKIPPED",
			"TIMED_OUT",
			"ACTION_REQUIRED",
			"STARTUP_FAILURE",
			"STALE",
		]),
	),
	startedAt: Schema.NullOr(Schema.String),
	completedAt: Schema.NullOr(Schema.String),
	detailsUrl: Schema.NullOr(Schema.String),
	// `CheckRun.checkSuite` is non-null (every check run belongs to one), but
	// its `workflowRun` is null for a check that wasn't produced by an
	// Actions workflow — mirrors `PullRequestCheck.workflowName`'s own `""`
	// case for a non-Actions GitHub App check.
	checkSuite: Schema.Struct({
		workflowRun: Schema.NullOr(
			Schema.Struct({ workflow: Schema.Struct({ name: Schema.String }) }),
		),
	}),
});
type GraphQLCheckRunNode = Schema.Schema.Type<typeof GraphQLCheckRunNode>;

const GraphQLStatusContextNode = Schema.Struct({
	__typename: Schema.Literal("StatusContext"),
	context: Schema.String,
	state: Schema.Literals([
		"EXPECTED",
		"ERROR",
		"FAILURE",
		"PENDING",
		"SUCCESS",
	]),
	targetUrl: Schema.NullOr(Schema.String),
});
type GraphQLStatusContextNode = Schema.Schema.Type<
	typeof GraphQLStatusContextNode
>;

/** GitHub's zero-value `DateTime` — see `pull-request-checks.ts`'s `NO_TIMESTAMP`; reused here as the target of a real `null` rather than a Go-flattened one. */
const NO_TIMESTAMP = "0001-01-01T00:00:00Z";

const toCheckRunView = (node: GraphQLCheckRunNode): CheckRunView => ({
	__typename: "CheckRun",
	name: node.name,
	status: node.status,
	conclusion: node.conclusion ?? "",
	startedAt: node.startedAt ?? NO_TIMESTAMP,
	completedAt: node.completedAt ?? NO_TIMESTAMP,
	detailsUrl: node.detailsUrl ?? "",
	workflowName: node.checkSuite.workflowRun?.workflow.name ?? "",
});

const toStatusContextView = (
	node: GraphQLStatusContextNode,
): StatusContextView => ({
	__typename: "StatusContext",
	context: node.context,
	state: node.state,
	// `toPullRequestCheck`'s `StatusContext` branch never reads `startedAt` —
	// GraphQL's own `StatusContext` has no such field at all (`createdAt` is
	// its closest analog) — but the shared view type still declares it, so a
	// harmless zero-value fills it rather than querying a field this module
	// has no use for.
	startedAt: NO_TIMESTAMP,
	targetUrl: node.targetUrl ?? "",
});

const GraphQLCheckNode = Schema.Union([
	GraphQLCheckRunNode,
	GraphQLStatusContextNode,
]);

const toOverviewCommitCheck = (
	node: GraphQLCheckRunNode | GraphQLStatusContextNode,
): OverviewCommitCheck => {
	const check = toPullRequestCheck(
		node.__typename === "CheckRun"
			? toCheckRunView(node)
			: toStatusContextView(node),
	);
	return {
		name: check.name,
		status: check.status,
		detail:
			check.workflowName === undefined || check.workflowName === ""
				? undefined
				: check.workflowName,
		detailsUrl:
			check.detailsUrl === undefined || check.detailsUrl === ""
				? undefined
				: check.detailsUrl,
	};
};

const GraphQLAuthorNode = Schema.Struct({
	name: Schema.NullOr(Schema.String),
	user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
});

const GraphQLCommitNode = Schema.Struct({
	commit: Schema.Struct({
		oid: Schema.String,
		abbreviatedOid: Schema.String,
		messageHeadline: Schema.String,
		messageBody: Schema.String,
		committedDate: Schema.String,
		url: Schema.String,
		authors: Schema.Struct({ nodes: Schema.Array(GraphQLAuthorNode) }),
		statusCheckRollup: Schema.NullOr(
			Schema.Struct({
				contexts: Schema.Struct({ nodes: Schema.Array(GraphQLCheckNode) }),
			}),
		),
	}),
});
type GraphQLCommitNode = Schema.Schema.Type<typeof GraphQLCommitNode>;

const GraphQLPullRequestOverviewResponse = Schema.Struct({
	data: Schema.Struct({
		repository: Schema.NullOr(
			Schema.Struct({
				pullRequest: Schema.NullOr(
					Schema.Struct({
						body: Schema.String,
						author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
						commits: Schema.Struct({ nodes: Schema.Array(GraphQLCommitNode) }),
					}),
				),
			}),
		),
	}),
});

const decodeOverviewResponse = (command: string, raw: string) =>
	Schema.decodeUnknownEffect(
		Schema.fromJsonString(GraphQLPullRequestOverviewResponse),
	)(raw).pipe(
		Effect.mapError(
			(cause) => new GhOutputDecodeError({ command, raw, cause }),
		),
	);

/**
 * `PullRequest.commits(last: 100)` orders its connection oldest-first —
 * GitHub's own PR commits tab ordering — so the 100 most recent commits come
 * back already in the order the wire contract promises, no client-side sort.
 * A PR with more than 100 commits silently shows only the most recent 100;
 * out of scope for this phase (matching the PR header's own checks/merge
 * procedures, which don't paginate either).
 */
const OVERVIEW_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      body
      author { login }
      commits(last: 100) {
        nodes {
          commit {
            oid
            abbreviatedOid
            messageHeadline
            messageBody
            committedDate
            url
            authors(first: 1) {
              nodes {
                name
                user { login }
              }
            }
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                    startedAt
                    completedAt
                    detailsUrl
                    checkSuite {
                      workflowRun {
                        workflow { name }
                      }
                    }
                  }
                  ... on StatusContext {
                    context
                    state
                    targetUrl
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

const toOverviewCommit = (
	repoRoot: string,
	node: GraphQLCommitNode,
): Effect.Effect<OverviewCommit, GhOutputDecodeError> => {
	const commit = node.commit;
	const author = commit.authors.nodes[0];
	if (author === undefined || author.name === null) {
		return Effect.fail(
			new GhOutputDecodeError({
				command: "gh api graphql (overview)",
				raw: JSON.stringify(node),
				cause: new Error(
					`commit ${commit.oid} in ${repoRoot} reported no git author name`,
				),
			}),
		);
	}

	return Effect.succeed({
		sha: commit.oid,
		shortSha: commit.abbreviatedOid,
		headline: commit.messageHeadline,
		body: commit.messageBody === "" ? null : commit.messageBody,
		authorName: author.name,
		authorLogin: author.user === null ? null : author.user.login,
		committedDate: commit.committedDate,
		url: commit.url,
		checks:
			commit.statusCheckRollup === null
				? null
				: commit.statusCheckRollup.contexts.nodes.map(toOverviewCommitCheck),
	});
};

/**
 * The Overview tab's PR-mode data source: one `gh api graphql` call for the
 * PR's description plus every commit's headline/body/author/CI rollup — a
 * REST-based alternative would need one `gh pr view` (for the description)
 * plus one check-runs call *per commit*, so this is the only shape that
 * costs one round trip regardless of how many commits the PR has.
 *
 * Failure classification mirrors `fetchPullRequestChecks`'s three-way split
 * (auth → rate-limited → not-found) — `gh api graphql` reports every failure
 * as the same non-zero exit `gh pr view` does, so the same
 * `isAuthFailure`/`isRateLimited` helpers apply unchanged. A PR that exists
 * but resolves `pullRequest: null` (a wrong number, same as a plain `gh pr
 * view` 404) is folded into that same non-zero-exit path — `gh api graphql`
 * exits non-zero whenever its response carries a GraphQL `errors` array,
 * confirmed live against a bogus PR number.
 */
export const fetchPullRequestOverview = (
	input: FetchPullRequestOverviewInput,
): Effect.Effect<
	PullRequestOverview,
	PullRequestChecksError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(input.repoRoot, [
			"api",
			"graphql",
			// `-f` (`--raw-field`), not `-F` (`--field`), for every string
			// variable — `-F`'s "looks like `true`/`false`/`null`/an integer"
			// magic type conversion is exactly wrong for an `owner`/`repo` that
			// happens to be all-digits or literally named `null`. `number` is the
			// one variable GraphQL actually declares `Int!`, so it alone needs
			// `-F`'s conversion.
			"-f",
			`query=${OVERVIEW_QUERY}`,
			"-f",
			`owner=${input.owner}`,
			"-f",
			`repo=${input.repo}`,
			"-F",
			`number=${input.number}`,
		]);

		if (result.exitCode !== 0) {
			if (isAuthFailure(result)) {
				return yield* new GhNotAuthenticated({
					reason: result.stderr.trim() || "gh is not authenticated",
				});
			}
			if (isRateLimited(result.stderr)) {
				return yield* new GhRateLimited({ reason: result.stderr.trim() });
			}
			return yield* new PullRequestNotFound({
				repoRoot: input.repoRoot,
				number: input.number,
				reason: result.stderr.trim(),
			});
		}

		const response = yield* decodeOverviewResponse(
			"gh api graphql (overview)",
			result.stdout,
		);
		const pullRequest = response.data.repository?.pullRequest;
		if (pullRequest === null || pullRequest === undefined) {
			return yield* new PullRequestNotFound({
				repoRoot: input.repoRoot,
				number: input.number,
				reason: "gh api graphql resolved no pull request for this number",
			});
		}
		if (pullRequest.author === null) {
			return yield* new GhOutputDecodeError({
				command: "gh api graphql (overview)",
				raw: result.stdout,
				cause: new Error(
					`pull request #${input.number} in ${input.repoRoot} has no attributable author`,
				),
			});
		}

		// Pure in-memory mapping, not I/O — no concurrency option to tune, unlike
		// this module's `ghResult` call.
		const commits = yield* Effect.forEach(pullRequest.commits.nodes, (node) =>
			toOverviewCommit(input.repoRoot, node),
		);

		return {
			description: {
				authorLogin: pullRequest.author.login,
				body: pullRequest.body === "" ? null : pullRequest.body,
			},
			commits,
		};
	});
