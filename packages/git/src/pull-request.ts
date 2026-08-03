import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	type GitCommandError,
	GitHubSearchUnreachable,
	GitHubUnreachable,
	type NoDefaultBranch,
	PullRequestNotFound,
	type PullRequestSearchError,
} from "./errors.ts";
import { type GhResult, ghResult, gitResult } from "./exec.ts";
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

const PrHeadRefView = Schema.Struct({ headRefName: Schema.String });

const decodePrHeadRefView = (command: string, raw: string) =>
	Effect.try({
		try: () => Schema.decodeUnknownSync(PrHeadRefView)(JSON.parse(raw)),
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

const PR_VIEW_JSON_FIELDS = "number,title,baseRefName,headRefName";

const toPullRequestRef = (
	view: Schema.Schema.Type<typeof PrView>,
): PullRequestRef => ({
	number: view.number,
	title: view.title,
	baseRef: view.baseRefName,
	headRef: view.headRefName,
});

/**
 * The shared half of resolving a `ReviewTarget`: the repo's GitHub identity
 * (owner/repo/defaultBranch) plus whatever `prViewArgs` names as the PR,
 * with the same no-remote/no-GitHub-host/unreachable classification either
 * caller needs. What differs between "the PR for the current branch"
 * (`resolveReviewTarget`) and "the PR with this number"
 * (`resolveReviewTargetForPullRequest`) is only `prViewArgs` itself and, more
 * importantly, what a non-zero `gh pr view` exit *means* — resolved by
 * `resolvePr` rather than a boolean, since "degrade to no PR" and "fail
 * outright" aren't two settings of one behavior, they're two different
 * contracts a caller can rely on.
 *
 * The two `gh` calls are independent network round trips to GitHub's API —
 * `pr view` resolves its PR from `prViewArgs` alone, not from `repo view`'s
 * output — so they run concurrently rather than paying their latency twice
 * sequentially.
 */
const resolveTargetForRepo = <PrError>(
	repoRoot: string,
	prViewArgs: ReadonlyArray<string>,
	resolvePr: (
		prResult: GhResult,
	) => Effect.Effect<PullRequestRef | null, PrError>,
): Effect.Effect<
	ReviewTarget,
	| GitHubUnreachable
	| GhOutputDecodeError
	| NoDefaultBranch
	| GitCommandError
	| PrError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
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
				ghResult(repoRoot, prViewArgs),
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
		const pr = yield* resolvePr(prResult);

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

/**
 * Resolves what a review of this repo is *against*: the PR open for the
 * current branch when there is one, GitHub's default branch when there isn't,
 * and the repo's own default branch when GitHub isn't in the picture at all.
 *
 * A repo with no remote, a remote on a host `gh` doesn't know, or an origin
 * pointing at a repository GitHub can't resolve are all normal local-review
 * cases — nisi reviews local branches, not only pull requests — so they
 * degrade to `github: null` rather than failing. Not being able to *ask*
 * GitHub (no `gh`, no auth, no network) stays a failure: see
 * `GitHubUnreachable`. A branch with no open PR degrades the same way — see
 * `resolveReviewTargetForPullRequest` for the one caller that can't accept
 * that degrade.
 */
const resolvePrForCurrentBranch = (
	prResult: GhResult,
): Effect.Effect<PullRequestRef | null, GhOutputDecodeError> =>
	prResult.exitCode === 0
		? decodePrView("gh pr view", prResult.stdout).pipe(
				Effect.map(toPullRequestRef),
			)
		: Effect.succeed(null);

export const resolveReviewTarget = (repoRoot: string) =>
	resolveTargetForRepo(
		repoRoot,
		["pr", "view", "--json", PR_VIEW_JSON_FIELDS],
		resolvePrForCurrentBranch,
	);

/**
 * Resolves a `ReviewTarget` for a PR named *by number* rather than by the
 * currently checked-out branch — what the "open pull request" palette needs
 * once it already knows which PR it's opening (see `worktree.ts`'s
 * `openPullRequestWorktree`, which checks the PR out into a nisi-local
 * branch that `gh pr view` with no arguments can never resolve).
 *
 * Everything about repo identity/default-branch resolution is identical to
 * `resolveReviewTarget` — the only difference is that a PR number the caller
 * explicitly picked failing to resolve is a real error
 * (`PullRequestNotFound`), not a silent degrade to the default-branch diff:
 * unlike the branch-based lookup, there's no "no PR for this branch, review
 * the branch itself" fallback that makes sense here.
 */
export const resolveReviewTargetForPullRequest = (
	repoRoot: string,
	number: number,
) => {
	const resolvePrByNumber = (
		prResult: GhResult,
	): Effect.Effect<
		PullRequestRef | null,
		GhOutputDecodeError | PullRequestNotFound
	> =>
		prResult.exitCode === 0
			? decodePrView("gh pr view", prResult.stdout).pipe(
					Effect.map(toPullRequestRef),
				)
			: Effect.fail(
					new PullRequestNotFound({
						repoRoot,
						number,
						reason: prResult.stderr.trim(),
					}),
				);

	return resolveTargetForRepo(
		repoRoot,
		["pr", "view", String(number), "--json", PR_VIEW_JSON_FIELDS],
		resolvePrByNumber,
	);
};

/**
 * The one field `openPullRequestWorktree` needs from a PR before its
 * worktree can even exist — the branch it fetches `refs/pull/<n>/head` into
 * is named `nisi/pr-<n>/<headRef>`, so `headRef` has to be known *before*
 * the worktree does, unlike the rest of a PR's review target
 * (`resolveReviewTargetForPullRequest`), which only matters once the
 * worktree already exists as `openSession`'s own `cwd`. Deliberately not
 * `resolveReviewTargetForPullRequest` reused wholesale for this — that call
 * also fetches `gh repo view` plus the PR's title/baseRef concurrently,
 * roughly twice the latency for a value that's thrown away the moment
 * `openSession` re-resolves the full target from the worktree's own path.
 */
export const resolvePullRequestHeadRef = (
	repoRoot: string,
	number: number,
): Effect.Effect<
	string,
	GhOutputDecodeError | PullRequestNotFound | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, [
			"pr",
			"view",
			String(number),
			"--json",
			"headRefName",
		]);
		if (result.exitCode !== 0) {
			return yield* new PullRequestNotFound({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		}
		const view = yield* decodePrHeadRefView("gh pr view", result.stdout);
		return view.headRefName;
	});

/**
 * One PR row `pullRequests.search` (the "open pull request" palette) renders.
 * Deliberately has no `headRef`/`baseRef` — unlike `PullRequestRef` above,
 * these aren't in `gh search prs`'s `--json` field set at all (confirmed via
 * `gh search prs --help`'s own `JSON FIELDS` list: `assignees, author,
 * authorAssociation, body, closedAt, commentsCount, createdAt, id, isDraft,
 * isLocked, isPullRequest, labels, number, repository, state, title,
 * updatedAt, url` — no ref names). Only `gh pr view <number>` (see
 * `resolveReviewTargetForPullRequest`) returns those, which is what actually
 * opening a result the palette shows still resolves through — a search
 * result is enough to *pick* a PR, not enough to check one out.
 */
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

const SearchPrItem = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	repository: Schema.Struct({ nameWithOwner: Schema.String }),
	author: Schema.Struct({ login: Schema.String }),
	updatedAt: Schema.String,
	url: Schema.String,
	isDraft: Schema.Boolean,
});

const decodeSearchPrList = (command: string, raw: string) =>
	Effect.try({
		try: () =>
			Schema.decodeUnknownSync(Schema.Array(SearchPrItem))(JSON.parse(raw)),
		catch: (cause) => new GhOutputDecodeError({ command, raw, cause }),
	});

/**
 * `repository.nameWithOwner` is `gh`'s own `"owner/name"` string, not a
 * struct — split here rather than trusting it blindly, so a shape `gh` ever
 * changes surfaces as the same `GhOutputDecodeError` every other decode
 * failure in this module does, not a thrown exception deep in an `Array.map`.
 */
const toPullRequestSearchResult = (
	item: Schema.Schema.Type<typeof SearchPrItem>,
): Effect.Effect<PullRequestSearchResult, GhOutputDecodeError> => {
	const [owner, repo] = item.repository.nameWithOwner.split("/");
	return owner === undefined || repo === undefined
		? Effect.fail(
				new GhOutputDecodeError({
					command: "gh search prs",
					raw: item.repository.nameWithOwner,
					cause: new Error(
						`expected "owner/repo", got ${JSON.stringify(item.repository.nameWithOwner)}`,
					),
				}),
			)
		: Effect.succeed({
				owner,
				repo,
				number: item.number,
				title: item.title,
				author: item.author.login,
				updatedAt: item.updatedAt,
				url: item.url,
				isDraft: item.isDraft,
			});
};

/**
 * GitHub's own search-qualifier vocabulary for issues/PRs (see
 * https://docs.github.com/search-github/searching-on-github/searching-issues-and-pull-requests),
 * used to detect whether a typed query already scopes itself — see
 * `hasSearchQualifier`. Enumerating the real set (rather than a bare
 * `includes(":")`) is what keeps ordinary text with a colon in it ("fix bug:
 * crash on save", "10:30 standup") from misfiring: none of those words are
 * qualifiers, so they never match, while `repo:foo/bar`, `-label:bug`, or
 * `is:draft` do.
 */
const GITHUB_SEARCH_QUALIFIERS = [
	"repo",
	"org",
	"user",
	"owner",
	"author",
	"assignee",
	"mentions",
	"team",
	"team-mentions",
	"commenter",
	"involves",
	"linked",
	"label",
	"milestone",
	"project",
	"state",
	"is",
	"type",
	"draft",
	"review",
	"reviewed-by",
	"review-requested",
	"user-review-requested",
	"team-review-requested",
	"created",
	"updated",
	"closed",
	"merged",
	"comments",
	"interactions",
	"reactions",
	"no",
	"language",
	"archived",
	"head",
	"base",
	"status",
	"in",
	"sort",
	"visibility",
	"app",
] as const;

/**
 * A qualifier token is `<word>:<value>` with no space around the colon, at a
 * token boundary (start of string or preceded by whitespace) and optionally
 * negated (`-label:bug`) — matching how a user would actually type one, not
 * a bare substring check.
 */
const QUALIFIER_PATTERN = new RegExp(
	`(?:^|\\s)-?(?:${GITHUB_SEARCH_QUALIFIERS.join("|")}):\\S`,
);

/** Whether `query` already scopes itself with a GitHub search qualifier — see `QUALIFIER_PATTERN`. */
const hasSearchQualifier = (query: string): boolean =>
	QUALIFIER_PATTERN.test(query);

/**
 * Whether `query` already names its own state (`state:open`, `is:merged`,
 * `-is:closed`, …) — narrower than `hasSearchQualifier`, since `is:draft` or
 * `is:locked` don't name a state and shouldn't suppress the default
 * `--state open` the way an actual state qualifier must (forcing `--state
 * open` on top of a query that already says `is:merged` would silently AND
 * the two into a contradiction and return nothing — confirmed live, see this
 * phase's report).
 */
const STATE_QUALIFIER_PATTERN =
	/(?:^|\s)-?(?:state|is):(?:open|closed|merged)\b/i;

const hasStateQualifier = (query: string): boolean =>
	STATE_QUALIFIER_PATTERN.test(query);

/**
 * Splits a typed query into `gh` positional arguments. `gh search prs` is
 * spawned via a raw argv array (see `exec.ts`), never a shell, so a query
 * like `repo:foo/bar auth` must arrive as two separate argv entries
 * (`"repo:foo/bar"`, `"auth"`) the same way a user's own shell would split
 * it unquoted — passed as one combined string, `gh` parses the whole thing
 * as a single quoted qualifier value instead (confirmed live: `repo:"foo/bar
 * auth"`, a query that matches nothing). Quoted phrases aren't preserved by
 * this split; that's out of scope here the same way it would be for a bare
 * shell-style tokenizer.
 */
const tokenize = (query: string): ReadonlyArray<string> =>
	query.split(/\s+/).filter((token) => token.length > 0);

const SEARCH_JSON_FIELDS =
	"number,title,repository,author,updatedAt,url,isDraft";

/**
 * `gh` not authenticated — confirmed live with `GH_CONFIG_DIR` pointed at an
 * empty directory (see this phase's report): exit code `4` (the one code
 * `gh help exit-codes` documents beyond 0/1/2, and names as
 * authentication-specific) and a "please run: gh auth login" message. A
 * *rejected* token (expired/revoked, confirmed live via a bogus `GH_TOKEN`)
 * is a different `gh` code path — plain exit `1`, "Bad credentials (HTTP
 * 401)" — so that's matched by message instead; it's still fixed the same
 * way (`gh auth login`/`gh auth refresh`), so it's classified the same.
 */
const AUTH_MARKERS = ["Bad credentials", "HTTP 401"] as const;

const isAuthFailure = (result: GhResult): boolean =>
	result.exitCode === 4 ||
	AUTH_MARKERS.some((marker) => result.stderr.includes(marker));

/**
 * GitHub's primary ("API rate limit exceeded") and secondary ("You have
 * exceeded a secondary rate limit") messages both contain this phrase — not
 * live-verified (deliberately: there's no safe way to actually exhaust the
 * account's rate limit from this machine without degrading `gh` for
 * whatever else uses it), so this is sourced from GitHub's documented error
 * text rather than an observed run. See this phase's report.
 */
const isRateLimited = (stderr: string): boolean => /rate limit/i.test(stderr);

const classifySearchFailure = (result: GhResult): PullRequestSearchError => {
	if (isAuthFailure(result)) {
		return new GhNotAuthenticated({
			reason: result.stderr.trim() || "gh is not authenticated",
		});
	}
	if (isRateLimited(result.stderr)) {
		return new GhRateLimited({ reason: result.stderr.trim() });
	}
	return new GitHubSearchUnreachable({
		reason: result.stderr.trim() || `gh search prs exited ${result.exitCode}`,
	});
};

const searchOnce = (
	cwd: string,
	terms: ReadonlyArray<string>,
	flags: ReadonlyArray<string>,
): Effect.Effect<
	ReadonlyArray<PullRequestSearchResult>,
	PullRequestSearchError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	ghResult(cwd, [
		"search",
		"prs",
		...terms,
		...flags,
		"--json",
		SEARCH_JSON_FIELDS,
	]).pipe(
		// `gh` never started at all (missing binary, permissions) — the one
		// failure that isn't an exit code to classify, same as every other `gh`
		// caller in this module.
		Effect.catchTag("GitCommandError", (cause) =>
			Effect.fail(
				new GitHubSearchUnreachable({
					reason: `gh could not be run: ${cause.stderr}`,
				}),
			),
		),
		Effect.flatMap((result) =>
			result.exitCode === 0
				? decodeSearchPrList("gh search prs", result.stdout).pipe(
						Effect.flatMap((items) =>
							Effect.forEach(items, toPullRequestSearchResult),
						),
					)
				: Effect.fail(classifySearchFailure(result)),
		),
	);

/**
 * Deduped by `owner/repo#number` (not number alone — unlike the old
 * per-repo `listMyOpenPullRequests`, this spans every repo the account can
 * see, so two different repos can share a PR number) and sorted by
 * `updatedAt` descending. The sort runs client-side rather than trusting
 * `gh`'s own ordering because the "involves me" branch below issues *two*
 * `gh search prs` calls and unions them — each individually sorted by `gh`
 * is not the same as the merged list being sorted, so this re-sorts once
 * after the union (and, for symmetry, after a single-call search too,
 * rather than having two different result-ordering code paths).
 */
const mergeResults = (
	results: ReadonlyArray<PullRequestSearchResult>,
): ReadonlyArray<PullRequestSearchResult> => {
	const byKey = new Map<string, PullRequestSearchResult>();
	for (const result of results) {
		byKey.set(`${result.owner}/${result.repo}#${result.number}`, result);
	}
	return Array.from(byKey.values()).sort((a, b) =>
		a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
	);
};

/**
 * Live `gh search prs` backing the "open pull request" palette — no local
 * index or cache, every call asks GitHub directly.
 *
 * - **Empty query**: the user's own latest open PRs, most recently updated
 *   first. Deliberately `author:@me` only, not also `review-requested:@me`
 *   — this is the literal decided default (see this phase's plan), not a
 *   union: an empty query's whole point is "my own work", which
 *   review-requested isn't.
 * - **Typed query, no qualifier**: scoped to PRs the user is involved in as
 *   *author or review-requested*. GitHub search can't `OR` two qualifiers in
 *   one query, and `involves:@me` is broader than what's wanted here (it
 *   also matches mentions and comments) — so, like the now-removed
 *   `listMyOpenPullRequests` this replaces, this issues two `gh search prs`
 *   calls (`--author=@me`, `--review-requested=@me`) and unions them via
 *   `mergeResults`, matching the plan's explicit "author or
 *   review-requested" wording exactly instead of approximating it.
 * - **Typed query with a qualifier already in it** (`repo:`, `author:`,
 *   `org:`, `is:`, …): passed straight through, unscoped — see
 *   `hasSearchQualifier`. This is the escape hatch for finding a PR the user
 *   isn't author or reviewer on (`repo:foo/bar auth`).
 *
 * `--state open` is added to every branch unless the query already names its
 * own state (`hasStateQualifier`) — forcing it on top of an explicit
 * `is:merged`/`is:closed` would otherwise silently return nothing (confirmed
 * live). `--sort updated` is likewise always requested, needed for
 * `mergeResults` above to produce one coherently-ordered list regardless of
 * how many `gh` calls fed it.
 *
 * Every failure here is a real failure, not a degrade-to-empty-list: unlike
 * `resolveReviewTarget`'s "GitHub isn't in play" cases (no remote, an
 * unknown host), a global PR search has no local, repo-scoped fallback to
 * degrade to — see `GhNotAuthenticated`/`GhRateLimited`/
 * `GitHubSearchUnreachable` for the three genuinely different things that
 * can go wrong and why they're kept distinct.
 */
export const searchPullRequests = (
	cwd: string,
	query: string,
): Effect.Effect<
	ReadonlyArray<PullRequestSearchResult>,
	PullRequestSearchError,
	ChildProcessSpawner.ChildProcessSpawner
> => {
	const trimmed = query.trim();
	const stateFlags = hasStateQualifier(trimmed) ? [] : ["--state", "open"];
	const sharedFlags = [...stateFlags, "--sort", "updated"];

	if (trimmed === "") {
		return searchOnce(cwd, [], ["--author", "@me", ...sharedFlags]).pipe(
			Effect.map(mergeResults),
		);
	}

	const terms = tokenize(trimmed);

	if (hasSearchQualifier(trimmed)) {
		return searchOnce(cwd, terms, sharedFlags).pipe(Effect.map(mergeResults));
	}

	return Effect.all(
		[
			searchOnce(cwd, terms, ["--author", "@me", ...sharedFlags]),
			searchOnce(cwd, terms, ["--review-requested", "@me", ...sharedFlags]),
		],
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map(([authored, reviewRequested]) =>
			mergeResults([...authored, ...reviewRequested]),
		),
	);
};
