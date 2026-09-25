import { Effect, Layer, PubSub } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitHub } from "../github.ts";
import { PullRequestAttention } from "./attention.ts";
import { fetchPullRequestChecks } from "./checks.ts";
import {
	fetchPullRequestMergeability,
	fetchRepoMergeMethods,
	markPullRequestReady,
	mergePullRequest,
	mergeStackPullRequest,
} from "./merge.ts";
import { fetchPullRequestOverview } from "./overview.ts";
import {
	headRef,
	pullRequest,
	repository,
	searchPullRequests,
} from "./pull-request.ts";
import { fetchPullRequestStack } from "./stack.ts";
import {
	checksInterval,
	kick,
	makeWatch,
	mergeStatusInterval,
	overviewInterval,
	stackInterval,
	watchFromMap,
} from "./watch.ts";

export const GhGitHub = {
	layer: Layer.effect(
		GitHub,
		Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const attention = yield* PullRequestAttention;
			const kicks = yield* PubSub.unbounded<string>();
			const provide = <A, E>(
				effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
			) =>
				Effect.provideService(
					effect,
					ChildProcessSpawner.ChildProcessSpawner,
					spawner,
				);
			const checks = yield* makeWatch(
				attention,
				kicks,
				(input) => provide(fetchPullRequestChecks(input)),
				checksInterval,
			);
			const mergeStatus = yield* makeWatch(
				attention,
				kicks,
				(input) =>
					Effect.all(
						[
							provide(
								fetchPullRequestMergeability(input.repoRoot, input.number),
							),
							provide(
								fetchRepoMergeMethods(input.repoRoot, input.owner, input.repo),
							),
						],
						{ concurrency: "unbounded" },
					).pipe(
						Effect.map((results) => ({
							mergeability: results[0],
							allowedMethods: results[1],
						})),
					),
				mergeStatusInterval,
			);
			const stack = yield* makeWatch(
				attention,
				kicks,
				(input) => provide(fetchPullRequestStack(input)),
				stackInterval,
			);
			const overview = yield* makeWatch(
				attention,
				kicks,
				(input) => provide(fetchPullRequestOverview(input)),
				overviewInterval,
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
					owner: string,
					repo: string,
					number: number,
					method: Parameters<typeof mergePullRequest>[2],
				) =>
					provide(mergePullRequest(repoRoot, number, method)).pipe(
						Effect.tap(() => kick(kicks, { owner, repo, number })),
					),
				mergeStack: (
					repoRoot: string,
					owner: string,
					repo: string,
					number: number,
					method: Parameters<typeof mergeStackPullRequest>[4],
				) =>
					provide(
						mergeStackPullRequest(repoRoot, owner, repo, number, method),
					).pipe(Effect.tap(() => kick(kicks, { owner, repo, number }))),
				markReady: (
					repoRoot: string,
					owner: string,
					repo: string,
					number: number,
				) =>
					provide(markPullRequestReady(repoRoot, number)).pipe(
						Effect.tap(() => kick(kicks, { owner, repo, number })),
					),
				watchChecks: (input: Parameters<typeof fetchPullRequestChecks>[0]) =>
					watchFromMap(checks, input),
				watchMergeStatus: (
					input: Parameters<typeof fetchPullRequestChecks>[0],
				) => watchFromMap(mergeStatus, input),
				watchStack: (input: Parameters<typeof fetchPullRequestStack>[0]) =>
					watchFromMap(stack, input),
				watchOverview: (
					input: Parameters<typeof fetchPullRequestOverview>[0],
				) => watchFromMap(overview, input),
			};
		}),
	),
};
