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
export const hasSearchQualifier = (query: string): boolean =>
	QUALIFIER_PATTERN.test(query);
