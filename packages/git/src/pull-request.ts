import { Effect, Schema } from "effect";
import { GhOutputDecodeError, GitHubUnreachable } from "./errors.ts";
import { ghResult, gitResult } from "./exec.ts";
import { resolveLocalDefaultBranch } from "./repo.ts";

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

/** Whether the repo has any remote at all — the one "GitHub isn't in play" answer that needs no network and no `gh`. */
const hasAnyRemote = (repoRoot: string) =>
	gitResult(repoRoot, ["remote"]).pipe(
		Effect.map(
			(result) => result.exitCode === 0 && result.stdout.trim() !== "",
		),
	);

/**
 * `gh` answering "there's no GitHub repository here" — an unknown host, a
 * repository that doesn't exist, or one this account can't see. Matched by
 * message rather than exit code because `gh` reports every failure as exit 1:
 * the alternative is to enumerate the *transport* failures instead, and those
 * (DNS, TLS, proxies, rate limits, expired tokens) are the open-ended set.
 * Anything unmatched is therefore treated as `GitHubUnreachable` — a repo
 * that silently reviews against the wrong base because the network blipped is
 * worse than one that says so.
 */
const NO_GITHUB_REPO_MARKERS = [
	"no git remotes found",
	"point to a known GitHub host",
	"Could not resolve to a Repository",
	"HTTP 404",
] as const;

const isNoGitHubRepo = (stderr: string) =>
	NO_GITHUB_REPO_MARKERS.some((marker) => stderr.includes(marker));

const localOnlyTarget = (repoRoot: string) =>
	resolveLocalDefaultBranch(repoRoot).pipe(
		Effect.map(
			(defaultBranch): ReviewTarget => ({ defaultBranch, github: null }),
		),
	);

/**
 * Resolves what a review of this repo is *against*: the PR open for the
 * current branch when there is one, GitHub's default branch when there isn't,
 * and the repo's own default branch when GitHub isn't in the picture at all.
 *
 * A repo with no remote, a remote on a host `gh` doesn't know, or an origin
 * pointing at a repository GitHub can't resolve are all normal local-review
 * cases — nisi reviews working trees, not only pull requests — so they
 * degrade to `github: null` rather than failing. Not being able to *ask*
 * GitHub (no `gh`, no auth, no network) stays a failure: see
 * `GitHubUnreachable`.
 *
 * The two `gh` calls are independent network round trips to GitHub's API —
 * `pr view` resolves its PR from the checked-out branch itself, not from
 * `repo view`'s output — so they run concurrently rather than paying their
 * latency twice sequentially.
 */
export const resolveReviewTarget = (repoRoot: string) =>
	Effect.gen(function* () {
		if (!(yield* hasAnyRemote(repoRoot)))
			return yield* localOnlyTarget(repoRoot);

		const [repoResult, prResult] = yield* Effect.all(
			[
				ghResult(repoRoot, [
					"repo",
					"view",
					"--json",
					"owner,name,defaultBranchRef",
				]),
				ghResult(repoRoot, [
					"pr",
					"view",
					"--json",
					"number,title,baseRefName,headRefName",
				]),
			],
			{ concurrency: "unbounded" },
		).pipe(
			// `gh` never started at all (missing binary, permissions) — the one
			// failure that isn't an exit code to classify.
			Effect.catchTag("GitCommandError", (cause) =>
				Effect.fail(
					new GitHubUnreachable({
						repoRoot,
						reason: `gh could not be run: ${cause.stderr}`,
					}),
				),
			),
		);

		if (repoResult.exitCode !== 0) {
			if (!isNoGitHubRepo(repoResult.stderr)) {
				return yield* new GitHubUnreachable({
					repoRoot,
					reason: repoResult.stderr.trim(),
				});
			}
			return yield* localOnlyTarget(repoRoot);
		}

		const repoInfo = yield* decodeRepoView("gh repo view", repoResult.stdout);
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

		const github: GitHubTarget = {
			owner: repoInfo.owner.login,
			repo: repoInfo.name,
			pr,
		};

		// An empty GitHub repository names no default branch, but a local clone
		// with commits still has one worth diffing against.
		const defaultBranch =
			repoInfo.defaultBranchRef === null
				? yield* resolveLocalDefaultBranch(repoRoot)
				: repoInfo.defaultBranchRef.name;

		return { defaultBranch, github };
	});
