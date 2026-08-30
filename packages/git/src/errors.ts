import { Schema } from "effect";

/**
 * A `git`/`gh` invocation didn't produce usable output — either it never
 * started (binary missing, permissions) or it exited non-zero. `exitCode` is
 * `null` for the former, so callers can tell "never ran" apart from "ran and
 * failed" without guessing from a sentinel number.
 */
export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
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
export class NotAGitRepository extends Schema.TaggedError<NotAGitRepository>()(
	"NotAGitRepository",
	{ cwd: Schema.String },
) {}

/** `gh`'s `--json` output didn't parse or didn't match the shape we expect. */
export class GhOutputDecodeError extends Schema.TaggedError<GhOutputDecodeError>()(
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
export class NoDefaultBranch extends Schema.TaggedError<NoDefaultBranch>()(
	"NoDefaultBranch",
	{ repoRoot: Schema.String },
) {}

/**
 * `gh` couldn't *ask* GitHub — the binary is missing, the user isn't
 * authenticated, or the API is unreachable. Deliberately distinct from
 * GitHub answering "no such repository", which is a normal local-only
 * review target (see `resolveReviewTarget`) rather than a failure.
 */
export class GitHubUnreachable extends Schema.TaggedError<GitHubUnreachable>()(
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
export class FileNotChanged extends Schema.TaggedError<FileNotChanged>()(
	"FileNotChanged",
	{ path: Schema.String },
) {}

/**
 * `readWorktreeBlobContent` couldn't read a worktree path as a
 * git-blob-equivalent value — `lstat`/`readlink`/`readFile` raised anything
 * other than the path simply not existing (permissions, a directory sitting
 * where the path used to be, ...). Absence itself isn't this: a deleted or
 * never-existed path is `Option.none()`, the common case every caller
 * already handles as a value, not a failure — see that function's doc
 * comment.
 */
export class WorktreeReadFailed extends Schema.TaggedError<WorktreeReadFailed>()(
	"WorktreeReadFailed",
	{
		path: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Neither `@{upstream}` nor `origin/<branch>` resolves for the current
 * branch — `resolveUnpushedCommitCount` (`repo.ts`) has nothing to diff
 * `HEAD` against, so the pre-merge "unpushed commits" check
 * (`apps/desktop/sidecar/http.ts`'s `unpushedCommits` handler) has no way to
 * tell whether anything is actually unpushed. Deliberately not defaulted to
 * a count of `0` — an unverifiable state isn't "nothing to push", and the
 * frontend shows a distinct dialog for it.
 */
export class NoRemoteRefToCompare extends Schema.TaggedError<NoRemoteRefToCompare>()(
	"NoRemoteRefToCompare",
	{ repoRoot: Schema.String, branch: Schema.String },
) {}

/**
 * `git rev-list --count <remoteRef>..HEAD` exited `0` (so `GitCommandError`
 * doesn't apply) but its stdout wasn't the plain non-negative integer that
 * flag always prints — near-unreachable in practice, but a value this
 * function can't trust isn't one it should coerce into a count: `Number()`
 * on unexpected output produces `NaN`, which would otherwise reach the wire
 * and render as "NaN commits" in the pre-merge dialog.
 */
export class UnpushedCommitCountUnparseable extends Schema.TaggedError<UnpushedCommitCountUnparseable>()(
	"UnpushedCommitCountUnparseable",
	{ repoRoot: Schema.String, remoteRef: Schema.String, raw: Schema.String },
) {}

export type GitError =
	| GitCommandError
	| NotAGitRepository
	| GhOutputDecodeError
	| NoDefaultBranch
	| GitHubUnreachable;

/** The repo has no `origin` remote — nothing to fetch a PR's ref from. */
export class NoOriginRemote extends Schema.TaggedError<NoOriginRemote>()(
	"NoOriginRemote",
	{ repoRoot: Schema.String },
) {}

/**
 * `origin` doesn't have this PR's `refs/pull/<n>/head` ref — the number is
 * wrong, or GitHub has garbage-collected it (long-closed PRs eventually lose
 * this ref).
 */
export class PullRequestRefNotFound extends Schema.TaggedError<PullRequestRefNotFound>()(
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
export class WorktreeBranchInUse extends Schema.TaggedError<WorktreeBranchInUse>()(
	"WorktreeBranchInUse",
	{ repoRoot: Schema.String, number: Schema.Number, stderr: Schema.String },
) {}

/**
 * The computed worktree path exists on disk but git has no worktree
 * registered there — a leftover directory (e.g. from before nisi tracked
 * worktrees, or a manual `rm` instead of `git worktree remove`) is in the way.
 */
export class WorktreePathOccupied extends Schema.TaggedError<WorktreePathOccupied>()(
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
 * A session's persisted worktree path no longer exists on disk, and nothing
 * checked out on its branch is registered in the repo's known main clone
 * either — `revalidateWorktreePath` (`worktree.ts`) couldn't recover it. The
 * worktree was genuinely removed (`git worktree remove`), not just relocated
 * (`git worktree move`, or an external tool like `wt`/worktrunk repointing a
 * worktree nisi created out from under it — the recoverable case, which
 * self-heals silently instead of reaching this error). `sourceRepoRoot` is
 * `null` when there was no known main clone to even check against (a branch
 * session opened directly against a plain checkout, never a nisi-managed PR
 * worktree) — that case has no second path to consult, so a missing `path`
 * fails outright.
 */
export class WorktreeRelocationFailed extends Schema.TaggedError<WorktreeRelocationFailed>()(
	"WorktreeRelocationFailed",
	{
		path: Schema.String,
		headRef: Schema.String,
		sourceRepoRoot: Schema.NullOr(Schema.String),
	},
) {}

/**
 * `gh pr view <number>` couldn't resolve the PR the caller asked for by
 * explicit number — wrong number, closed/deleted since, or a `gh` error.
 * Distinct from the branch-based lookup `resolveReviewTarget` does, which
 * degrades a missing PR to `github.pr: null` rather than failing: a caller
 * that names a PR number explicitly (the "open PR" palette) has no local
 * branch's PR to fall back to, so a number `gh` can't resolve is a genuine
 * error, not a silent degrade to the default-branch diff.
 */
export class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()(
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
export class GhNotAuthenticated extends Schema.TaggedError<GhNotAuthenticated>()(
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
export class GhRateLimited extends Schema.TaggedError<GhRateLimited>()(
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
export class GitHubSearchUnreachable extends Schema.TaggedError<GitHubSearchUnreachable>()(
	"GitHubSearchUnreachable",
	{ reason: Schema.String },
) {}

export type PullRequestSearchError =
	| GhOutputDecodeError
	| GhNotAuthenticated
	| GhRateLimited
	| GitHubSearchUnreachable;

/** A candidate repo path (a sibling guess, or a user-picked folder) doesn't exist on disk at all. */
export class RepoPathNotFound extends Schema.TaggedError<RepoPathNotFound>()(
	"RepoPathNotFound",
	{ path: Schema.String },
) {}

/** A candidate repo path exists but isn't inside a git working tree. */
export class RepoPathNotAGitRepo extends Schema.TaggedError<RepoPathNotAGitRepo>()(
	"RepoPathNotAGitRepo",
	{ path: Schema.String },
) {}

/** A candidate repo path is a git working tree, but has no `origin` remote to compare against. */
export class RepoPathNoOriginRemote extends Schema.TaggedError<RepoPathNoOriginRemote>()(
	"RepoPathNoOriginRemote",
	{ path: Schema.String },
) {}

/**
 * A candidate repo path's `origin` remote doesn't resolve to the expected
 * `owner/repo` — either it points somewhere else entirely, or its URL
 * couldn't be parsed as an `owner/repo` at all (`actualOwner`/`actualRepo`
 * are `null` in that case).
 */
export class RepoPathOriginMismatch extends Schema.TaggedError<RepoPathOriginMismatch>()(
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

/**
 * `gh pr view <number> --json ...,mergeStateStatus,...` failed on that field
 * specifically — GitHub only resolves `mergeStateStatus` for an actor with
 * push access to the repo, an undocumented `gh` quirk confirmed via the
 * GraphQL permission error it surfaces (`pull-request-merge.ts`'s
 * `isMergeStatusPermissionFailure`). Distinct from `PullRequestNotFound`:
 * the PR itself resolves fine, only this one field doesn't — so a caller
 * checking mergeability from a fork or a read-only clone gets a real error
 * instead of a silently substituted `"UNKNOWN"`.
 */
export class PullRequestMergeStatusUnavailable extends Schema.TaggedError<PullRequestMergeStatusUnavailable>()(
	"PullRequestMergeStatusUnavailable",
	{ repoRoot: Schema.String, number: Schema.Number, reason: Schema.String },
) {}

/**
 * `gh repo view` reported every merge method (merge/squash/rebase) disabled
 * — a genuine repo misconfiguration (GitHub requires at least one enabled to
 * merge anything through the UI or API at all), not a case to silently
 * default a method for.
 */
export class NoMergeMethodsEnabled extends Schema.TaggedError<NoMergeMethodsEnabled>()(
	"NoMergeMethodsEnabled",
	{ owner: Schema.String, repo: Schema.String },
) {}

/**
 * `gh pr merge` refused because the PR isn't actually mergeable right now
 * (conflicts, a blocked/required check, behind base, ...) — matched by
 * message since `gh` reports this as a plain exit 1 like every other
 * failure.
 */
export class PullRequestNotMergeable extends Schema.TaggedError<PullRequestNotMergeable>()(
	"PullRequestNotMergeable",
	{ repoRoot: Schema.String, number: Schema.Number, reason: Schema.String },
) {}

/**
 * `gh pr merge` failed for a reason that isn't auth, not-found, or
 * not-mergeable — the catch-all so a merge attempt never silently no-ops.
 */
export class GhMergeFailed extends Schema.TaggedError<GhMergeFailed>()(
	"GhMergeFailed",
	{ repoRoot: Schema.String, number: Schema.Number, reason: Schema.String },
) {}

export type PullRequestMergeabilityError =
	| GhOutputDecodeError
	| GhNotAuthenticated
	| GhRateLimited
	| PullRequestMergeStatusUnavailable
	| PullRequestNotFound;

/**
 * Every way `fetchPullRequestChecks` (`pull-request-checks.ts`) can fail —
 * no new tagged errors of its own, since a PR-scoped `gh pr view` call has
 * exactly the same three failure shapes `fetchPullRequestMergeability`
 * already has: not authenticated, rate-limited, or the PR itself couldn't be
 * resolved. `GhOutputDecodeError` covers `statusCheckRollup` not matching the
 * two check shapes that module decodes.
 */
export type PullRequestChecksError =
	| GhOutputDecodeError
	| GhNotAuthenticated
	| GhRateLimited
	| PullRequestNotFound;

export type RepoMergeMethodsError =
	| GhOutputDecodeError
	| GhNotAuthenticated
	| GhRateLimited
	| GitHubUnreachable
	| NoMergeMethodsEnabled;

export type PullRequestMergeError =
	| GhNotAuthenticated
	| PullRequestNotFound
	| PullRequestNotMergeable
	| GhMergeFailed;

/**
 * `gh pr ready` failed for a reason that isn't auth or not-found — the
 * catch-all so marking a PR ready for review never silently no-ops. Mirrors
 * `GhMergeFailed`'s role for `mergePullRequest`.
 */
export class GhPullRequestReadyFailed extends Schema.TaggedError<GhPullRequestReadyFailed>()(
	"GhPullRequestReadyFailed",
	{ repoRoot: Schema.String, number: Schema.Number, reason: Schema.String },
) {}

export type PullRequestReadyError =
	| GhNotAuthenticated
	| PullRequestNotFound
	| GhPullRequestReadyFailed;
