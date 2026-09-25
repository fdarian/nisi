import { Effect, Layer } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitHub } from "../github.ts";
import { fetchPullRequestChecks } from "./checks.ts";
import { fetchPullRequestOverview } from "./overview.ts";
import { fetchPullRequestStack } from "./stack.ts";
import {
	fetchPullRequestMergeability,
	fetchRepoMergeMethods,
	markPullRequestReady,
	mergePullRequest,
	mergeStackPullRequest,
} from "./merge.ts";
import {
	headRef,
	pullRequest,
	repository,
	searchPullRequests,
} from "./pull-request.ts";

export const GhGitHub = {
	layer: Layer.effect(
		GitHub,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const provide = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) =>
				Effect.provideService(
					effect,
					ChildProcessSpawner.ChildProcessSpawner,
					spawner,
				);
			return {
				repository: (repoRoot: string) => provide(repository(repoRoot)),
				pullRequest: (repoRoot: string, number?: number) =>
					provide(pullRequest(repoRoot, number)),
				headRef: (repoRoot: string, number: number) =>
					provide(headRef(repoRoot, number)),
				search: (cwd: string, query: string) =>
					provide(searchPullRequests(cwd, query)),
				checks: (input: Parameters<typeof fetchPullRequestChecks>[0]) =>
					provide(fetchPullRequestChecks(input)),
				overview: (input: Parameters<typeof fetchPullRequestOverview>[0]) =>
					provide(fetchPullRequestOverview(input)),
				stack: (input: Parameters<typeof fetchPullRequestStack>[0]) =>
					provide(fetchPullRequestStack(input)),
				mergeability: (repoRoot: string, number: number) =>
					provide(fetchPullRequestMergeability(repoRoot, number)),
				mergeMethods: (repoRoot: string, owner: string, repo: string) =>
					provide(fetchRepoMergeMethods(repoRoot, owner, repo)),
				merge: (
					repoRoot: string,
					number: number,
					method: Parameters<typeof mergePullRequest>[2],
				) => provide(mergePullRequest(repoRoot, number, method)),
				mergeStack: (
					repoRoot: string,
					owner: string,
					repo: string,
					number: number,
					method: Parameters<typeof mergeStackPullRequest>[4],
				) =>
					provide(mergeStackPullRequest(repoRoot, owner, repo, number, method)),
				markReady: (repoRoot: string, number: number) =>
					provide(markPullRequestReady(repoRoot, number)),
			};
		}),
	),
};
