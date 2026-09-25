import { Effect, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
	GhNotAuthenticated,
	GhOutputDecodeError,
	GhRateLimited,
	type GitCommandError,
	GitHubSearchUnreachable,
	GitHubUnreachable,
	PullRequestNotFound,
	type PullRequestSearchError,
} from "../../errors.ts";
import { type GhResult, ghResult } from "../../exec.ts";
import type {
	PullRequestRef,
	PullRequestSearchResult,
} from "../../pull-request.ts";
import type { RepositoryIdentity } from "../github.ts";

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

const PR_VIEW_JSON_FIELDS = "number,title,baseRefName,headRefName";

const toPullRequestRef = (
	view: Schema.Schema.Type<typeof PrView>,
): PullRequestRef => ({
	number: view.number,
	title: view.title,
	baseRef: view.baseRefName,
	headRef: view.headRefName,
});

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

/** Exported for `pull-request-merge.ts`, whose `gh pr view`/`gh repo view`/`gh pr merge` calls hit the same authentication failure shape. */
export const isAuthFailure = (result: GhResult): boolean =>
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
/** Exported for `pull-request-merge.ts` — same GitHub API rate-limit message shape. */
export const isRateLimited = (stderr: string): boolean =>
	/rate limit/i.test(stderr);

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

export const repository = (
	repoRoot: string,
): Effect.Effect<
	RepositoryIdentity | null,
	GitHubUnreachable | GhOutputDecodeError | GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, [
			"repo",
			"view",
			"--json",
			"owner,name,defaultBranchRef",
		]).pipe(
			Effect.catchTag(
				"GitCommandError",
				(cause) =>
					new GitHubUnreachable({
						repoRoot,
						reason: `gh could not be run: ${cause.stderr}`,
					}),
			),
		);
		if (result.exitCode !== 0) {
			if (isNoGitHubRepo(result.stderr)) return null;
			return yield* new GitHubUnreachable({
				repoRoot,
				reason: result.stderr.trim(),
			});
		}
		const view = yield* decodeRepoView("gh repo view", result.stdout);
		return {
			owner: view.owner.login,
			repo: view.name,
			defaultBranch: view.defaultBranchRef?.name ?? null,
		};
	});

export const pullRequest = (repoRoot: string, number?: number) =>
	Effect.gen(function* () {
		const args =
			number === undefined
				? ["pr", "view", "--json", PR_VIEW_JSON_FIELDS]
				: ["pr", "view", String(number), "--json", PR_VIEW_JSON_FIELDS];
		const result = yield* ghResult(repoRoot, args);
		if (result.exitCode !== 0) {
			if (number === undefined) return null;
			return yield* new PullRequestNotFound({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		}
		return toPullRequestRef(yield* decodePrView("gh pr view", result.stdout));
	});

export const headRef = (repoRoot: string, number: number) =>
	Effect.gen(function* () {
		const result = yield* ghResult(repoRoot, [
			"pr",
			"view",
			String(number),
			"--json",
			"headRefName",
		]);
		if (result.exitCode !== 0)
			return yield* new PullRequestNotFound({
				repoRoot,
				number,
				reason: result.stderr.trim(),
			});
		return (yield* decodePrHeadRefView("gh pr view", result.stdout))
			.headRefName;
	});
