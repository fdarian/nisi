import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import {
	GhOutputDecodeError,
	type PullRequestSearchError,
} from "../../errors.ts";
import { runGraphqlSearch } from "./pull-request.ts";

const REPOSITORY_SEARCH_QUERY = `query($q: String!, $n: Int!) {
  search(type: REPOSITORY, query: $q, first: $n) {
    nodes { ... on Repository { name owner { login } } }
  }
}`;
const REPOSITORY_SEARCH_LIMIT = 20;

const RepositorySearchResponse = Schema.Struct({
	data: Schema.Struct({
		search: Schema.Struct({
			nodes: Schema.Array(
				Schema.NullOr(
					Schema.Struct({
						name: Schema.String,
						owner: Schema.Struct({ login: Schema.String }),
					}),
				),
			),
		}),
	}),
});

/** `owner/name` narrows to that owner's repos; plain text matches repository names anywhere. `fork:true` keeps forks, which GitHub hides by default. */
export const repositorySearchQuery = (input: string): string => {
	const trimmed = input.trim();
	const slash = trimmed.indexOf("/");
	if (slash === -1) {
		return `${trimmed} in:name fork:true`;
	}
	const owner = trimmed.slice(0, slash);
	const name = trimmed.slice(slash + 1);
	return [
		`user:${owner}`,
		...(name === "" ? [] : [`${name} in:name`]),
		"fork:true",
	].join(" ");
};

export const searchRepositories = (
	cwd: string,
	query: string,
): Effect.Effect<
	ReadonlyArray<{ readonly owner: string; readonly repo: string }>,
	PullRequestSearchError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	runGraphqlSearch(cwd, REPOSITORY_SEARCH_QUERY, [
		"-f",
		`q=${repositorySearchQuery(query)}`,
		"-F",
		`n=${REPOSITORY_SEARCH_LIMIT}`,
	]).pipe(
		Effect.flatMap((stdout) =>
			Schema.decodeUnknownEffect(
				Schema.fromJsonString(RepositorySearchResponse),
			)(stdout).pipe(
				Effect.mapError(
					(cause) =>
						new GhOutputDecodeError({
							command: "gh api graphql",
							raw: stdout,
							cause,
						}),
				),
			),
		),
		Effect.map((response) =>
			response.data.search.nodes
				.filter((node) => node !== null)
				.map((node) => ({ owner: node.owner.login, repo: node.name })),
		),
	);
