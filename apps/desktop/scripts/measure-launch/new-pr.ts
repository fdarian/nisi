import {
	GhGitHub,
	PullRequestAttention,
	resolveCurrentBranch,
	resolveMainCloneRoot,
	resolveRepoRoot,
	resolveReviewTarget,
} from "@repo/git";
import { Effect, Layer, Stream } from "effect";

const identity = (cwd: string) =>
	Effect.gen(function* () {
		const root = yield* resolveRepoRoot(cwd);
		const clone = yield* resolveMainCloneRoot(root);
		const branch = yield* resolveCurrentBranch(root);
		const target = yield* resolveReviewTarget(root);
		const github = target.github;
		return {
			clone,
			branch,
			pr:
				github?.pr === null || github === null
					? undefined
					: `${github.owner.toLowerCase()}/${github.repo.toLowerCase()}#${github.pr.number}`,
		};
	});

export function validateNewPr(
	target: { clone: string; branch: string; pr?: string },
	warmup: { clone: string; branch: string; pr?: string },
): string {
	if (target.clone !== warmup.clone)
		throw new Error(
			"Warm-up and target must be worktrees of the same repository",
		);
	if (
		target.branch === warmup.branch ||
		(target.pr !== undefined && target.pr === warmup.pr)
	)
		throw new Error("Warm-up and target resolve to the same PR or branch");
	return warmup.pr === undefined ? `branch ${warmup.branch}` : warmup.pr;
}

export const resolveWarmup = (cwd: string, warmup: string) =>
	Effect.gen(function* () {
		const targets = yield* Effect.all([identity(cwd), identity(warmup)], {
			concurrency: "unbounded",
		});
		return yield* Effect.try(() => validateNewPr(targets[0], targets[1]));
	}).pipe(
		Effect.provide(GhGitHub.layer),
		Effect.provide(
			Layer.succeed(PullRequestAttention, { changes: () => Stream.empty }),
		),
	);
