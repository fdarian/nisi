import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	type GitCommandError,
	PullRequestNotFound,
} from "./errors.ts";
import { ghResult } from "./exec.ts";
import { isAuthFailure, isRateLimited } from "./pull-request.ts";

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

const GraphQLStackEntry = Schema.Struct({
	position: Schema.Number,
	pullRequest: Schema.Struct({
		number: Schema.Number,
		title: Schema.String,
		state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
		isDraft: Schema.Boolean,
		headRefName: Schema.String,
		baseRefName: Schema.String,
	}),
});

const GraphQLPullRequestStackResponse = Schema.Struct({
	data: Schema.Struct({
		repository: Schema.NullOr(
			Schema.Struct({
				pullRequest: Schema.NullOr(
					Schema.Struct({
						stackEntry: Schema.NullOr(
							Schema.Struct({ position: Schema.Number }),
						),
						stack: Schema.NullOr(
							Schema.Struct({
								number: Schema.Number,
								size: Schema.Number,
								baseRefName: Schema.String,
								entries: Schema.Struct({
									nodes: Schema.Array(GraphQLStackEntry),
								}),
							}),
						),
					}),
				),
			}),
		),
	}),
});

type GraphQLPullRequestStackResponse = Schema.Schema.Type<
	typeof GraphQLPullRequestStackResponse
>;

const STACK_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      stackEntry { position }
      stack {
        number
        size
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest {
              number
              title
              state
              isDraft
              headRefName
              baseRefName
            }
          }
        }
      }
    }
  }
}
`;

const decodeStackResponse = (command: string, raw: string) =>
	Schema.decodeUnknownEffect(
		Schema.fromJsonString(GraphQLPullRequestStackResponse),
	)(raw).pipe(
		Effect.mapError(
			(cause) => new GhOutputDecodeError({ command, raw, cause }),
		),
	);

const toPullRequestStack = (
	response: GraphQLPullRequestStackResponse,
	repoRoot: string,
	number: number,
): Effect.Effect<PullRequestStack | null, GhOutputDecodeError> => {
	const pullRequest = response.data.repository?.pullRequest;
	if (pullRequest === null || pullRequest === undefined) {
		return new GhOutputDecodeError({
			command: "gh api graphql (stack)",
			raw: JSON.stringify(response),
			cause: new Error(
				`pull request #${number} in ${repoRoot} was missing from the decoded response`,
			),
		});
	}

	if (pullRequest.stack === null) return Effect.succeed(null);
	if (pullRequest.stackEntry === null) {
		return new GhOutputDecodeError({
			command: "gh api graphql (stack)",
			raw: JSON.stringify(response),
			cause: new Error(
				`pull request #${number} in ${repoRoot} had a stack without a stack entry`,
			),
		});
	}

	const entries = [...pullRequest.stack.entries.nodes]
		.sort((left, right) => left.position - right.position)
		.map((entry) => ({
			position: entry.position,
			number: entry.pullRequest.number,
			title: entry.pullRequest.title,
			headRefName: entry.pullRequest.headRefName,
			baseRefName: entry.pullRequest.baseRefName,
			state: entry.pullRequest.state,
			isDraft: entry.pullRequest.isDraft,
		}));

	return Effect.succeed({
		number: pullRequest.stack.number,
		size: pullRequest.stack.size,
		baseRefName: pullRequest.stack.baseRefName,
		position: pullRequest.stackEntry.position,
		entries,
	});
};

/** Reads a PR's preview stacked-PR membership; `null` is GitHub's real not-stacked result. */
export const fetchPullRequestStack = (
	input: FetchPullRequestStackInput,
): Effect.Effect<
	PullRequestStack | null,
	PullRequestStackError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(input.repoRoot, [
			"api",
			"graphql",
			"-f",
			`query=${STACK_QUERY}`,
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

		const response = yield* decodeStackResponse(
			"gh api graphql (stack)",
			result.stdout,
		);
		return yield* toPullRequestStack(response, input.repoRoot, input.number);
	});
