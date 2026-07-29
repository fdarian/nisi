import { Effect, Schema } from "effect";
import { GhOutputDecodeError, NoDefaultBranch } from "./errors.ts";
import { gh, ghResult } from "./exec.ts";

const RepoView = Schema.Struct({
	owner: Schema.Struct({ login: Schema.String }),
	name: Schema.String,
	defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
});

const PrView = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	baseRefName: Schema.String,
	headRefName: Schema.String,
});

const decodeRepoView = (command: string, raw: string) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(RepoView)(JSON.parse(raw)),
		catch: (cause) => new GhOutputDecodeError({ command, raw, cause }),
	});

const decodePrView = (command: string, raw: string) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(PrView)(JSON.parse(raw)),
		catch: (cause) => new GhOutputDecodeError({ command, raw, cause }),
	});

export type PullRequestRef = {
	readonly number: number;
	readonly title: string;
	readonly baseRef: string;
	readonly headRef: string;
};

export type ReviewTarget = {
	readonly owner: string;
	readonly repo: string;
	readonly defaultBranch: string;
	readonly pr: PullRequestRef | null;
};

/**
 * Resolves everything `gh` can tell us about the review target: the repo's
 * identity and default branch (always), plus the PR open for the current
 * branch (when there is one). `gh pr view` exiting non-zero is the expected
 * "no PR for this branch" case — detached HEAD included — so it degrades to
 * `pr: null` rather than failing the whole resolution.
 *
 * The two `gh` calls are independent network round trips to GitHub's API —
 * `pr view` resolves its PR from the checked-out branch itself, not from
 * `repo view`'s output — so they run concurrently rather than paying their
 * latency twice sequentially.
 */
export const resolveReviewTarget = (repoRoot: string) =>
	Effect.gen(function* () {
		const [repoRaw, prResult] = yield* Effect.all(
			[
				gh(repoRoot, ["repo", "view", "--json", "owner,name,defaultBranchRef"]),
				ghResult(repoRoot, [
					"pr",
					"view",
					"--json",
					"number,title,baseRefName,headRefName",
				]),
			],
			{ concurrency: "unbounded" },
		);

		const repoInfo = yield* decodeRepoView("gh repo view", repoRaw);
		const owner = repoInfo.owner.login;
		const repo = repoInfo.name;

		if (repoInfo.defaultBranchRef === null) {
			return yield* new NoDefaultBranch({ owner, repo });
		}
		const defaultBranch = repoInfo.defaultBranchRef.name;

		const pr: PullRequestRef | null =
			prResult.exitCode === 0
				? yield* decodePrView("gh pr view", prResult.stdout).pipe(
						Effect.map((view) => ({
							number: view.number,
							title: view.title,
							baseRef: view.baseRefName,
							headRef: view.headRefName,
						})),
					)
				: null;

		return { owner, repo, defaultBranch, pr };
	});
