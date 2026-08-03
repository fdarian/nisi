import { Schema } from "effect";

/**
 * A `git`/`gh` invocation didn't produce usable output — either it never
 * started (binary missing, permissions) or it exited non-zero. `exitCode` is
 * `null` for the former, so callers can tell "never ran" apart from "ran and
 * failed" without guessing from a sentinel number.
 */
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()(
	"GitCommandError",
	{
		command: Schema.String,
		args: Schema.Array(Schema.String),
		cwd: Schema.String,
		exitCode: Schema.NullOr(Schema.Number),
		stderr: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** `cwd` (or an ancestor) isn't inside a git working tree. */
export class NotAGitRepository extends Schema.TaggedErrorClass<NotAGitRepository>()(
	"NotAGitRepository",
	{ cwd: Schema.String },
) {}

/** `gh`'s `--json` output didn't parse or didn't match the shape we expect. */
export class GhOutputDecodeError extends Schema.TaggedErrorClass<GhOutputDecodeError>()(
	"GhOutputDecodeError",
	{
		command: Schema.String,
		raw: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Nothing in the repo names a branch to review against — neither GitHub nor
 * the repo's own refs (`origin/HEAD`, `init.defaultBranch`, `main`,
 * `master`). An empty repository with no commits is the usual cause.
 */
export class NoDefaultBranch extends Schema.TaggedErrorClass<NoDefaultBranch>()(
	"NoDefaultBranch",
	{ repoRoot: Schema.String },
) {}

/**
 * `gh` couldn't *ask* GitHub — the binary is missing, the user isn't
 * authenticated, or the API is unreachable. Deliberately distinct from
 * GitHub answering "no such repository", which is a normal local-only
 * review target (see `resolveReviewTarget`) rather than a failure.
 */
export class GitHubUnreachable extends Schema.TaggedErrorClass<GitHubUnreachable>()(
	"GitHubUnreachable",
	{ repoRoot: Schema.String, reason: Schema.String },
) {}

/**
 * A path turned out not to be part of the current diff. `getFileContents`
 * (`diff.ts`) never raises this itself — a path missing from a batch is
 * simply absent from its result map — so this exists for callers that need
 * fail-fast, single-path semantics on top of that (e.g.
 * `apps/desktop/sidecar/walkthrough/context.ts`'s `gatherGenerationContext`,
 * which constructs one manually when a requested path comes back missing).
 */
export class FileNotChanged extends Schema.TaggedErrorClass<FileNotChanged>()(
	"FileNotChanged",
	{ path: Schema.String },
) {}

export type GitError =
	| GitCommandError
	| NotAGitRepository
	| GhOutputDecodeError
	| NoDefaultBranch
	| GitHubUnreachable;

/** The repo has no `origin` remote — nothing to fetch a PR's ref from. */
export class NoOriginRemote extends Schema.TaggedErrorClass<NoOriginRemote>()(
	"NoOriginRemote",
	{ repoRoot: Schema.String },
) {}

/**
 * `origin` doesn't have this PR's `refs/pull/<n>/head` ref — the number is
 * wrong, or GitHub has garbage-collected it (long-closed PRs eventually lose
 * this ref).
 */
export class PullRequestRefNotFound extends Schema.TaggedErrorClass<PullRequestRefNotFound>()(
	"PullRequestRefNotFound",
	{ repoRoot: Schema.String, number: Schema.Number },
) {}

/**
 * The PR's nisi-owned local branch became checked out in a different
 * worktree between `openPullRequestWorktree`'s own `git worktree list`
 * check and its `fetch`/`worktree add` — a race, not the common case: that
 * check now reuses an already-checked-out branch instead of erroring, so
 * this only still surfaces when something else (another nisi process, a
 * manual `git worktree add`) wins the race in between.
 */
export class WorktreeBranchInUse extends Schema.TaggedErrorClass<WorktreeBranchInUse>()(
	"WorktreeBranchInUse",
	{ repoRoot: Schema.String, number: Schema.Number, stderr: Schema.String },
) {}

/**
 * The computed worktree path exists on disk but git has no worktree
 * registered there — a leftover directory (e.g. from before nisi tracked
 * worktrees, or a manual `rm` instead of `git worktree remove`) is in the way.
 */
export class WorktreePathOccupied extends Schema.TaggedErrorClass<WorktreePathOccupied>()(
	"WorktreePathOccupied",
	{ path: Schema.String },
) {}

export type PullRequestWorktreeError =
	| GitCommandError
	| NoOriginRemote
	| PullRequestRefNotFound
	| WorktreeBranchInUse
	| WorktreePathOccupied;

/**
 * `gh pr view <number>` couldn't resolve the PR the caller asked for by
 * explicit number — wrong number, closed/deleted since, or a `gh` error.
 * Distinct from the branch-based lookup `resolveReviewTarget` does, which
 * degrades a missing PR to `github.pr: null` rather than failing: a caller
 * that names a PR number explicitly (the "open PR" palette) has no local
 * branch's PR to fall back to, so a number `gh` can't resolve is a genuine
 * error, not a silent degrade to the default-branch diff.
 */
export class PullRequestNotFound extends Schema.TaggedErrorClass<PullRequestNotFound>()(
	"PullRequestNotFound",
	{ repoRoot: Schema.String, number: Schema.Number, reason: Schema.String },
) {}

/**
 * `gh search prs` ran but `gh` itself isn't authenticated — confirmed live
 * (see `pull-request.ts`'s `searchPullRequests`) by exit code `4`, the one
 * code `gh help exit-codes` documents beyond 0/1/2 and names as
 * authentication-specific, plus a couple of message markers for the
 * adjacent "token is present but rejected" case (`gh` itself still exits 1
 * for that one). Fixed by `gh auth login`/`gh auth refresh`, not by
 * retrying or waiting — kept distinct from `GhRateLimited` and
 * `GitHubSearchUnreachable` so the palette can tell the user which one
 * actually applies instead of one generic "search failed".
 */
export class GhNotAuthenticated extends Schema.TaggedErrorClass<GhNotAuthenticated>()(
	"GhNotAuthenticated",
	{ reason: Schema.String },
) {}

/**
 * GitHub's search API answered with a rate limit — primary (the account's
 * hourly quota) or secondary (too many requests too quickly). `gh` reports
 * every non-auth API failure as plain exit `1` with no dedicated code, so
 * this is matched by message rather than exit status. A "wait and retry"
 * condition, not a "something's broken" one.
 */
export class GhRateLimited extends Schema.TaggedErrorClass<GhRateLimited>()(
	"GhRateLimited",
	{ reason: Schema.String },
) {}

/**
 * `gh search prs` couldn't reach GitHub at all — DNS, TLS, a dropped
 * connection, or any other API failure that isn't `GhNotAuthenticated` or
 * `GhRateLimited`. Deliberately has no `repoRoot` (unlike `GitHubUnreachable`):
 * a PR search spans every repo the account can see, not one checkout, so
 * there's no single repo to attribute the failure to. The catch-all for
 * anything the other two don't already explain — same reasoning as
 * `pull-request.ts`'s `isNoGitHubRepo` treating everything unmatched as a
 * failure rather than silently returning no results.
 */
export class GitHubSearchUnreachable extends Schema.TaggedErrorClass<GitHubSearchUnreachable>()(
	"GitHubSearchUnreachable",
	{ reason: Schema.String },
) {}

export type PullRequestSearchError =
	| GhOutputDecodeError
	| GhNotAuthenticated
	| GhRateLimited
	| GitHubSearchUnreachable;

/** A candidate repo path (a sibling guess, or a user-picked folder) doesn't exist on disk at all. */
export class RepoPathNotFound extends Schema.TaggedErrorClass<RepoPathNotFound>()(
	"RepoPathNotFound",
	{ path: Schema.String },
) {}

/** A candidate repo path exists but isn't inside a git working tree. */
export class RepoPathNotAGitRepo extends Schema.TaggedErrorClass<RepoPathNotAGitRepo>()(
	"RepoPathNotAGitRepo",
	{ path: Schema.String },
) {}

/** A candidate repo path is a git working tree, but has no `origin` remote to compare against. */
export class RepoPathNoOriginRemote extends Schema.TaggedErrorClass<RepoPathNoOriginRemote>()(
	"RepoPathNoOriginRemote",
	{ path: Schema.String },
) {}

/**
 * A candidate repo path's `origin` remote doesn't resolve to the expected
 * `owner/repo` — either it points somewhere else entirely, or its URL
 * couldn't be parsed as an `owner/repo` at all (`actualOwner`/`actualRepo`
 * are `null` in that case).
 */
export class RepoPathOriginMismatch extends Schema.TaggedErrorClass<RepoPathOriginMismatch>()(
	"RepoPathOriginMismatch",
	{
		path: Schema.String,
		expectedOwner: Schema.String,
		expectedRepo: Schema.String,
		actualOwner: Schema.NullOr(Schema.String),
		actualRepo: Schema.NullOr(Schema.String),
		remoteUrl: Schema.String,
	},
) {}

/**
 * Every way `verifyRepoPathMatchesOrigin` (`repo-path-mapping.ts`) can
 * decide a candidate path is *not* usable for `owner/repo` — a value an
 * inference guess treats as "keep looking" and a user-picked folder treats
 * as "reject with this reason," never as a reason to trust an unverified
 * path.
 */
export type RepoPathVerificationError =
	| RepoPathNotFound
	| RepoPathNotAGitRepo
	| RepoPathNoOriginRemote
	| RepoPathOriginMismatch;
