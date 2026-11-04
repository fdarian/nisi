import { Effect, Result } from "effect";
import type {
	GhOutputDecodeError,
	GitHubUnreachable,
	PullRequestNotFound,
} from "./errors.ts";
import { gitResult } from "./exec.ts";
import { GitHub, type GitHubShape } from "./github/github.ts";
import { resolveLocalDefaultBranch } from "./repo.ts";

export type PullRequestRef = {
	readonly number: number;
	readonly title: string;
	readonly baseRef: string;
	readonly headRef: string;
	readonly isCrossRepository: boolean;
	readonly authorLogin: string;
};

/** What GitHub reported about a PR at the moment it was read, alongside its {@link PullRequestRef}. */
export type ViewedPullRequest = {
	readonly ref: PullRequestRef;
	readonly facts: {
		readonly state: "OPEN" | "CLOSED" | "MERGED";
		readonly headSha: string;
		readonly baseSha: string;
	};
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

export type PullRequestSearchState = "open" | "closed";

/** How far back `closed` searches reach: the last 7 days, the last 30 days, or no limit. */
export type PullRequestClosedWindow = "week" | "month" | "all";

export type PullRequestSearchResult = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly title: string;
	readonly author: string;
	readonly updatedAt: string;
	readonly url: string;
	readonly isDraft: boolean;
	readonly state: "OPEN" | "CLOSED" | "MERGED";
	readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	readonly mergeStateStatus:
		| "BEHIND"
		| "BLOCKED"
		| "CLEAN"
		| "DIRTY"
		| "DRAFT"
		| "HAS_HOOKS"
		| "UNKNOWN"
		| "UNSTABLE";
	readonly rollupState:
		| "EXPECTED"
		| "ERROR"
		| "FAILURE"
		| "PENDING"
		| "SUCCESS"
		| null;
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

const resolveTarget = (
	repoRoot: string,
	lookups: (github: GitHubShape) => {
		readonly repository: ReturnType<GitHubShape["repository"]>;
		readonly pullRequest: Effect.Effect<
			ViewedPullRequest | null,
			PullRequestNotFound | GhOutputDecodeError | GitHubUnreachable
		>;
	},
) =>
	Effect.gen(function* () {
		if (!(yield* hasAnyRemote(repoRoot)))
			return yield* localOnlyTarget(repoRoot);
		const github = yield* GitHub;
		const effects = lookups(github);
		const results = yield* Effect.all(
			[effects.repository, Effect.result(effects.pullRequest)],
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
			github: {
				owner: identity.owner,
				repo: identity.repo,
				pr: pr.success === null ? null : pr.success.ref,
			},
		} satisfies ReviewTarget;
	});

/** Detects the repository and PR from the checkout, as `gh` resolves them. */
export const resolveReviewTarget = (repoRoot: string) =>
	resolveTarget(repoRoot, (github) => ({
		repository: github.repository(repoRoot),
		pullRequest: github.pullRequest(repoRoot),
	}));

/** Addresses `owner/repo#number` explicitly, so a fork checkout's `gh` default (the upstream) can't redirect it. */
export const resolveReviewTargetForPullRequest = (
	repoRoot: string,
	target: {
		readonly owner: string;
		readonly repo: string;
		readonly number: number;
	},
) =>
	resolveTarget(repoRoot, (github) => ({
		repository: github.repositoryByName(repoRoot, target.owner, target.repo),
		pullRequest: github.pullRequestByNumber(
			repoRoot,
			target.owner,
			target.repo,
			target.number,
		),
	}));
