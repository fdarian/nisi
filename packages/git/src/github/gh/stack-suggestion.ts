import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	type GitCommandError,
	PullRequestNotFound,
} from "../../errors.ts";
import { ghResult } from "../../exec.ts";
import type {
	FetchPullRequestStackInput,
	PullRequestStackError,
	PullRequestStackSuggestion,
} from "../models.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";

const OpenPullRequestNode = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	isDraft: Schema.Boolean,
	headRefName: Schema.String,
	baseRefName: Schema.String,
	isCrossRepository: Schema.Boolean,
	stack: Schema.NullOr(Schema.Struct({ number: Schema.Number })),
});
export type OpenPullRequestNode = Schema.Schema.Type<
	typeof OpenPullRequestNode
>;

const GraphQLOpenPullRequestsResponse = Schema.Struct({
	data: Schema.Struct({
		repository: Schema.NullOr(
			Schema.Struct({
				pullRequests: Schema.Struct({
					nodes: Schema.Array(OpenPullRequestNode),
				}),
			}),
		),
	}),
});

// A repo with more than 100 open PRs may truncate a chain; a suggestion is a
// hint, so a missed one beats paginating on every poll.
const OPEN_PULL_REQUESTS_QUERY = `
query($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100) {
      nodes {
        number
        title
        isDraft
        headRefName
        baseRefName
        isCrossRepository
        stack { number }
      }
    }
  }
}
`;

const COMMAND = "gh api graphql (stack suggestion)";

/**
 * Infers a linear chain of open same-repo PRs (each based on the previous one's
 * head branch) that GitHub hasn't turned into a native stack. `null` when the
 * target isn't part of a chain of at least two.
 */
export const inferStackSuggestion = (
	openPullRequests: ReadonlyArray<OpenPullRequestNode>,
	number: number,
): PullRequestStackSuggestion | null => {
	const candidates = openPullRequests.filter(
		(pullRequest) =>
			!pullRequest.isCrossRepository && pullRequest.stack === null,
	);
	const target = candidates.find(
		(pullRequest) => pullRequest.number === number,
	);
	if (target === undefined) return null;

	const chain = [target];
	const inChain = new Set([target.number]);

	for (;;) {
		const bottom = chain[0] as OpenPullRequestNode;
		const parent = candidates.find(
			(pullRequest) =>
				pullRequest.headRefName === bottom.baseRefName &&
				!inChain.has(pullRequest.number),
		);
		if (parent === undefined) break;
		chain.unshift(parent);
		inChain.add(parent.number);
	}

	for (;;) {
		const top = chain[chain.length - 1] as OpenPullRequestNode;
		const children = candidates.filter(
			(pullRequest) =>
				pullRequest.baseRefName === top.headRefName &&
				!inChain.has(pullRequest.number),
		);
		const child = children[0];
		if (children.length !== 1 || child === undefined) break;
		chain.push(child);
		inChain.add(child.number);
	}

	if (chain.length < 2) return null;

	return {
		baseRefName: (chain[0] as OpenPullRequestNode).baseRefName,
		size: chain.length,
		position:
			chain.findIndex((pullRequest) => pullRequest.number === number) + 1,
		entries: chain.map((pullRequest, index) => ({
			position: index + 1,
			number: pullRequest.number,
			title: pullRequest.title,
			headRefName: pullRequest.headRefName,
			baseRefName: pullRequest.baseRefName,
			state: "OPEN" as const,
			isDraft: pullRequest.isDraft,
		})),
	};
};

/** Suggests stacking a PR whose branches already form a chain of open PRs that GitHub doesn't know as a stack. */
export const fetchPullRequestStackSuggestion = (
	input: FetchPullRequestStackInput,
): Effect.Effect<
	PullRequestStackSuggestion | null,
	PullRequestStackError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(input.repoRoot, [
			"api",
			"graphql",
			"-f",
			`query=${OPEN_PULL_REQUESTS_QUERY}`,
			"-f",
			`owner=${input.owner}`,
			"-f",
			`repo=${input.repo}`,
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

		const response = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(GraphQLOpenPullRequestsResponse),
		)(result.stdout).pipe(
			Effect.mapError(
				(cause) =>
					new GhOutputDecodeError({
						command: COMMAND,
						raw: result.stdout,
						cause,
					}),
			),
		);

		const repository = response.data.repository;
		if (repository === null) {
			return yield* new GhOutputDecodeError({
				command: COMMAND,
				raw: result.stdout,
				cause: new Error(
					`repository ${input.owner}/${input.repo} was missing from the decoded response`,
				),
			});
		}
		return inferStackSuggestion(repository.pullRequests.nodes, input.number);
	});
