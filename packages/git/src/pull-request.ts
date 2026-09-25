import { Effect, Result } from "effect";
import { gitResult } from "./exec.ts";
import { GitHub } from "./github/github.ts";
import { resolveLocalDefaultBranch } from "./repo.ts";

export type PullRequestRef = {
	readonly number: number;
	readonly title: string;
	readonly baseRef: string;
	readonly headRef: string;
};

/** The repo's GitHub identity plus the PR open for the current branch, when GitHub knows this repo at all. */
export type GitHubTarget = {
	readonly owner: string;
	readonly repo: string;
	readonly pr: PullRequestRef | null;
};

export type ReviewTarget = {
	/** The branch to diff against: the PR's base, GitHub's default branch, or the repo's own (see `resolveLocalDefaultBranch`). */
	readonly defaultBranch: string;
	readonly github: GitHubTarget | null;
};

export type PullRequestSearchResult = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly author: string;
	readonly updatedAt: string;
	readonly url: string;
	readonly isDraft: boolean;
};

const hasAnyRemote = (repoRoot: string) =>
	gitResult(repoRoot, ["remote"]).pipe(
		Effect.map(
			(result) => result.exitCode === 0 && result.stdout.trim() !== "",
		),
	);

const localOnlyTarget = (repoRoot: string) =>
	resolveLocalDefaultBranch(repoRoot).pipe(
		Effect.map(
			(defaultBranch): ReviewTarget => ({ defaultBranch, github: null }),
		),
	);

const resolveTarget = (repoRoot: string, number?: number) =>
	Effect.gen(function* () {
		if (!(yield* hasAnyRemote(repoRoot)))
			return yield* localOnlyTarget(repoRoot);
		const github = yield* GitHub;
		const results = yield* Effect.all(
			[
				github.repository(repoRoot),
				Effect.result(github.pullRequest(repoRoot, number)),
			],
			{ concurrency: "unbounded" },
		);
		const identity = results[0];
		const pr = results[1];
		if (Result.isFailure(pr) && pr.failure._tag === "GitHubUnreachable")
			return yield* Effect.fail(pr.failure);
		if (identity === null) return yield* localOnlyTarget(repoRoot);
		if (Result.isFailure(pr)) return yield* Effect.fail(pr.failure);
		const defaultBranch =
			identity.defaultBranch === null
				? yield* resolveLocalDefaultBranch(repoRoot)
				: identity.defaultBranch;
		return {
			defaultBranch,
			github: { owner: identity.owner, repo: identity.repo, pr: pr.success },
		} satisfies ReviewTarget;
	});

export const resolveReviewTarget = (repoRoot: string) =>
	resolveTarget(repoRoot);
export const resolveReviewTargetForPullRequest = (
	repoRoot: string,
	number: number,
) => resolveTarget(repoRoot, number);

export const resolvePullRequestHeadRef = (repoRoot: string, number: number) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.headRef(repoRoot, number);
	});

export const searchPullRequests = (cwd: string, query: string) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.search(cwd, query);
	});
