import { Effect, Layer, PubSub } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitHub } from "../github.ts";
import { PullRequestAttention } from "./attention.ts";
import { approveWorkflowRuns, fetchPullRequestChecks } from "./checks.ts";
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
				repository: (repoRoot) => provide(repository(repoRoot)),
				pullRequest: (repoRoot, number) =>
					provide(pullRequest(repoRoot, number)),
				headRef: (repoRoot, number) => provide(headRef(repoRoot, number)),
				search: (cwd, query) => provide(searchPullRequests(cwd, query)),
				checks: (input) => provide(fetchPullRequestChecks(input)),
				approveWorkflowRuns: (input) =>
					provide(approveWorkflowRuns(input)).pipe(
						Effect.onExit(() => kick(kicks, input)),
					),
				overview: (input) => provide(fetchPullRequestOverview(input)),
				stack: (input) => provide(fetchPullRequestStack(input)),
				mergeability: (repoRoot, number) =>
					provide(fetchPullRequestMergeability(repoRoot, number)),
				mergeMethods: (repoRoot, owner, repo) =>
					provide(fetchRepoMergeMethods(repoRoot, owner, repo)),
				merge: (repoRoot, owner, repo, number, method) =>
					mergePullRequest(repoRoot, number, method).pipe(
						provide,
						Effect.tap(() => kick(kicks, { owner, repo, number })),
					),
				mergeStack: (repoRoot, owner, repo, number, method) =>
					mergeStackPullRequest(repoRoot, owner, repo, number, method).pipe(
						provide,
						Effect.tap(() => kick(kicks, { owner, repo, number })),
					),
				markReady: (repoRoot, owner, repo, number) =>
					markPullRequestReady(repoRoot, number).pipe(
						provide,
						Effect.tap(() => kick(kicks, { owner, repo, number })),
					),
				watchChecks: (input) => watchFromMap(checks, input),
				watchMergeStatus: (input) => watchFromMap(mergeStatus, input),
				watchStack: (input) => watchFromMap(stack, input),
				watchOverview: (input) => watchFromMap(overview, input),
			} satisfies GitHub["Service"];
		}),
	),
};
