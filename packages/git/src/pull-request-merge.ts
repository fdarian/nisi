import { Effect } from "effect";
import { GitHub } from "./github/github.ts";
export type { MergeMethod, PullRequestMergeability } from "./github/models.ts";
export const fetchPullRequestMergeability = (
	repoRoot: string,
	number: number,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.mergeability(repoRoot, number);
	});
export const fetchRepoMergeMethods = (
	repoRoot: string,
	owner: string,
	repo: string,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.mergeMethods(repoRoot, owner, repo);
	});
export const mergePullRequest = (
	repoRoot: string,
	number: number,
	method: import("./github/models.ts").MergeMethod,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.merge(repoRoot, number, method);
	});
export const mergeStackPullRequest = (
	repoRoot: string,
	owner: string,
	repo: string,
	number: number,
	method: import("./github/models.ts").MergeMethod,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.mergeStack(repoRoot, owner, repo, number, method);
	});
export const markPullRequestReady = (repoRoot: string, number: number) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.markReady(repoRoot, number);
	});
