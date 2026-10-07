import { Effect, Schema } from "effect";
import { GhOutputDecodeError, GitHubUnreachable } from "../../errors.ts";
import { ghResult } from "../../exec.ts";
import type {
	OpenPullRequestIndex,
	OpenPullRequestIndexOptions,
} from "../github.ts";

const Response = Schema.Struct({
	data: Schema.Struct({
		repository: Schema.Struct({
			owner: Schema.Struct({ login: Schema.String }),
			name: Schema.String,
			defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
			pullRequests: Schema.Struct({
				nodes: Schema.Array(
					Schema.Struct({
						number: Schema.Number,
						title: Schema.String,
						baseRefName: Schema.String,
						headRefName: Schema.String,
						isCrossRepository: Schema.Boolean,
						updatedAt: Schema.String,
						state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
						headRepositoryOwner: Schema.NullOr(
							Schema.Struct({ login: Schema.String }),
						),
					}),
				),
				pageInfo: Schema.Struct({
					hasNextPage: Schema.Boolean,
					endCursor: Schema.NullOr(Schema.String),
				}),
			}),
		}),
	}),
});

export const listOpenPullRequests = (
	cwd: string,
	owner: string,
	repo: string,
	options?: OpenPullRequestIndexOptions,
) =>
	Effect.gen(function* () {
		const updatedSince = options?.updatedSince;
		const states =
			updatedSince === undefined ? "OPEN" : "[OPEN, CLOSED, MERGED]";
		const query = `query($owner: String!, $repo: String!, $after: String) { repository(owner: $owner, name: $repo) { owner { login } name defaultBranchRef { name } pullRequests(states: ${states}, first: 100, after: $after, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number title baseRefName headRefName isCrossRepository updatedAt state headRepositoryOwner { login } } pageInfo { hasNextPage endCursor } } } }`;
		const fetchPage = (after?: string) =>
			Effect.gen(function* () {
				const args = [
					"api",
					"graphql",
					"-f",
					`query=${query}`,
					"-f",
					`owner=${owner}`,
					"-f",
					`repo=${repo}`,
					...(after === undefined ? [] : ["-f", `after=${after}`]),
				];
				const result = yield* ghResult(cwd, args).pipe(
					Effect.catchTag(
						"GitCommandError",
						(cause) =>
							new GitHubUnreachable({ repoRoot: cwd, reason: cause.stderr }),
					),
				);
				if (result.exitCode !== 0)
					return yield* new GitHubUnreachable({
						repoRoot: cwd,
						reason: result.stderr,
					});
				return yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(Response),
				)(result.stdout).pipe(
					Effect.mapError(
						(cause) =>
							new GhOutputDecodeError({
								command: "gh api graphql (open PR index)",
								raw: result.stdout,
								cause,
							}),
					),
					Effect.map((response) => response.data.repository),
				);
			});
		const first = yield* fetchPage();
		const prs: OpenPullRequestIndex["prs"][number][] = [];
		const removedNumbers: number[] = [];
		const seen = new Set<string>();
		const repository = {
			owner: first.owner.login,
			repo: first.name,
			defaultBranch: first.defaultBranchRef?.name ?? null,
		};
		const highWaterMark = first.pullRequests.nodes.reduce<string | undefined>(
			(latest, pr) =>
				latest === undefined || pr.updatedAt > latest ? pr.updatedAt : latest,
			updatedSince,
		);
		const seenNumbers = new Set<number>();
		const toPr = (pr: (typeof first.pullRequests.nodes)[number]) => ({
			number: pr.number,
			title: pr.title,
			baseRef: pr.baseRefName,
			headRef: pr.headRefName,
			isCrossRepository: pr.isCrossRepository,
			headOwner: pr.headRepositoryOwner?.login ?? null,
		});
		const collect = (
			page: typeof first,
		): Effect.Effect<
			void,
			GhOutputDecodeError | GitHubUnreachable,
			import("effect/unstable/process").ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const nodes = page.pullRequests.nodes.filter(
					(pr) => !seenNumbers.has(pr.number),
				);
				for (const pr of nodes) seenNumbers.add(pr.number);
				const pagePrs = nodes.filter((pr) => pr.state === "OPEN").map(toPr);
				const pageRemoved = nodes
					.filter((pr) => pr.state !== "OPEN")
					.map((pr) => pr.number);
				removedNumbers.push(...pageRemoved);
				prs.push(...pagePrs);
				if (options?.onPage !== undefined)
					yield* options.onPage({
						repository,
						prs: pagePrs,
						removedNumbers: pageRemoved,
						...(highWaterMark === undefined ? {} : { highWaterMark }),
					});
				if (
					updatedSince !== undefined &&
					page.pullRequests.nodes.some((pr) => pr.updatedAt < updatedSince)
				)
					return;
				if (!page.pullRequests.pageInfo.hasNextPage) return;
				const cursor = page.pullRequests.pageInfo.endCursor;
				if (cursor === null || seen.has(cursor))
					return yield* new GhOutputDecodeError({
						command: "gh api graphql (open PR index)",
						raw: JSON.stringify(page),
						cause: new Error("missing or repeated pagination cursor"),
					});
				seen.add(cursor);
				return yield* collect(yield* fetchPage(cursor));
			});
		yield* collect(first);
		return {
			repository,
			...(highWaterMark === undefined ? {} : { highWaterMark }),
			prs,
			removedNumbers,
		} satisfies OpenPullRequestIndex;
	});
