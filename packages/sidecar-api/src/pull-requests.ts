import { oc } from "@orpc/contract";
import { Schema } from "effect";
import { Session } from "./sessions.ts";

/**
 * One row the "open pull request" palette renders — mirrors `@repo/git`'s
 * `PullRequestSearchResult` (this package stays dependency-free from every
 * domain package, same reasoning as `diff.ts` mirroring `@repo/git`'s
 * `FileChange`). No `headRef`/`baseRef`, no local `repoPath` — `gh search
 * prs`'s `--json` output doesn't have the former at all (see
 * `@repo/git/src/pull-request.ts`'s `PullRequestSearchResult` doc), and the
 * latter is exactly what `open` below resolves server-side (a known or
 * inferred mapping, or a `"needs-repo-path"` prompt) once a result is
 * picked — a search row only ever needs to carry enough to identify and
 * render the PR, not to open it.
 */
export const PullRequestSearchResult = Schema.Struct({
	owner: Schema.String,
	repo: Schema.String,
	number: Schema.Number,
	title: Schema.String,
	author: Schema.String,
	updatedAt: Schema.String,
	url: Schema.String,
	isDraft: Schema.Boolean,
});
export type PullRequestSearchResult = Schema.Schema.Type<
	typeof PullRequestSearchResult
>;

/**
 * `open`'s two possible outcomes — a discriminated union rather than two
 * separate procedures (a pre-flight `resolveRepoPath` the frontend always
 * calls first) or a thrown "not configured" error. The palette only ever
 * knows `owner/repo#number`, never a local path, so `open` has to resolve
 * (or ask for) that path itself; the common case — the mapping is already
 * known, from a prior open or a verified sibling-directory guess (see
 * `@repo/settings`'s `repoPaths` table and `@repo/git`'s `inferRepoPath`) —
 * is by far the more frequent one, so it has to stay a single round trip:
 * call `open`, get a session back. A separate pre-flight route would make
 * *every* open pay for a check that only the rare, first-time-per-repo case
 * needs. `"needs-repo-path"` is that rare case surfacing as data, not an
 * error: the frontend's flow is prompt (native folder picker) → `recordRepoPath`
 * → call `open` again, now resolved. Same shape `pullRequests.sync` used for
 * `{ status: "not-configured" }` before phase A removed it.
 */
export const OpenPullRequestOutcome = Schema.Union([
	Schema.Struct({ status: Schema.Literal("opened"), session: Session }),
	Schema.Struct({
		status: Schema.Literal("needs-repo-path"),
		owner: Schema.String,
		repo: Schema.String,
	}),
]);
export type OpenPullRequestOutcome = Schema.Schema.Type<
	typeof OpenPullRequestOutcome
>;

/** A confirmed `owner/repo` → local checkout path mapping, echoed back by `recordRepoPath` once its `origin` has been verified. */
export const RepoPathMapping = Schema.Struct({
	owner: Schema.String,
	repo: Schema.String,
	path: Schema.String,
});
export type RepoPathMapping = Schema.Schema.Type<typeof RepoPathMapping>;

/** Mirrors `@repo/git`'s `MergeMethod` — the merge strategy GitHub's own PR UI offers, in its own ordering (Merge → Squash → Rebase). */
export const MergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type MergeMethod = Schema.Schema.Type<typeof MergeMethod>;

/**
 * Mirrors `@repo/git`'s `PullRequestMergeability` plus the repo's enabled
 * merge methods, combined into one struct since the PR header's Merge
 * button needs both to render at all (a disabled/enabled state from the
 * former, a method picker from the latter). `defaultMethod` is computed
 * server-side — the first of `allowedMethods` in GitHub's own UI ordering —
 * since GitHub exposes no "default method" field of its own; see
 * `apps/desktop/sidecar/http.ts`'s `mergeStatus` handler.
 */
export const PullRequestMergeStatus = Schema.Struct({
	state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
	mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
	mergeStateStatus: Schema.Literals([
		"BEHIND",
		"BLOCKED",
		"CLEAN",
		"DIRTY",
		"DRAFT",
		"HAS_HOOKS",
		"UNKNOWN",
		"UNSTABLE",
	]),
	isDraft: Schema.Boolean,
	allowedMethods: Schema.Array(MergeMethod),
	defaultMethod: MergeMethod,
});
export type PullRequestMergeStatus = Schema.Schema.Type<
	typeof PullRequestMergeStatus
>;

/**
 * Mirrors `@repo/git`'s `UnpushedCommits` — how many commits the local
 * worktree branch has that its remote doesn't, plus the remote ref
 * (`origin/main`, or whatever `@{upstream}` names) that count was computed
 * against, since the pre-merge dialog names it rather than saying "the
 * remote" generically.
 */
export const UnpushedCommits = Schema.Struct({
	count: Schema.Number,
	remoteRef: Schema.String,
});
export type UnpushedCommits = Schema.Schema.Type<typeof UnpushedCommits>;

/** Mirrors `@repo/git`'s `PullRequestCheckStatus` — the 5-state vocabulary `apps/desktop/src/components/pr/ci-status.tsx`'s `CiCheckStatus` renders. */
export const PullRequestCheckStatus = Schema.Literals([
	"passing",
	"failing",
	"running",
	"pending",
	"skipped",
]);
export type PullRequestCheckStatus = Schema.Schema.Type<
	typeof PullRequestCheckStatus
>;

/**
 * Mirrors `@repo/git`'s `PullRequestCheck` — one CI check attached to a PR,
 * GitHub Actions or an external status integration alike. Deliberately
 * *not* structurally identical to `ci-status.tsx`'s `CiCheck`: `durationMs`
 * is a fact, not a formatted string — turning it into `CiCheck`'s `detail`
 * text is `pr-ci-status.tsx`'s job, the one place that actually knows how a
 * duration should read. Keeping that formatting here would leak a
 * presentation concern two layers below the UI. `workflowName` is carried
 * for the same reason: `name` alone isn't guaranteed unique (two different
 * Actions workflows can both define a job called `test`), and only
 * `pr-ci-status.tsx` — once it can see the whole fetched set — knows which
 * names are actually ambiguous and need qualifying.
 */
export const PullRequestCheck = Schema.Struct({
	name: Schema.String,
	status: PullRequestCheckStatus,
	durationMs: Schema.optional(Schema.Number),
	detailsUrl: Schema.optional(Schema.String),
	workflowName: Schema.optional(Schema.String),
});
export type PullRequestCheck = Schema.Schema.Type<typeof PullRequestCheck>;

/**
 * `search` asks GitHub live via `@repo/git`'s `searchPullRequests` — no
 * local index or cache, so every call is a real `gh search prs` round trip.
 * See that function's own doc for the empty-query/typed-query/qualifier-
 * passthrough behavior and the `author`-or-`review-requested` union it
 * performs for a typed, unscoped query.
 *
 * Its three failure modes are kept as three distinct contract errors rather
 * than one generic "search failed", mirroring `open`'s below: `gh` not
 * authenticated (`GH_NOT_AUTHENTICATED` — fixed by `gh auth login`, not a
 * retry), GitHub's search API rate-limiting the account
 * (`TOO_MANY_REQUESTS` — a wait-and-retry condition), and everything else
 * that keeps `gh` from reaching GitHub at all (`SERVICE_UNAVAILABLE`, the
 * same code `open`'s `GitHubUnreachable` already maps to below — see
 * `apps/desktop/sidecar/http.ts`'s handler for the mapping from
 * `@repo/git`'s tagged errors to these).
 *
 * `open` resolves `owner/repo` to a local checkout (known mapping, or a
 * verified sibling guess — see `OpenPullRequestOutcome` above), create-or-
 * reuses a worktree for the PR there (via `@repo/git`'s
 * `openPullRequestWorktree`), and hands its path to the *existing*
 * `sessions.open` domain logic — deliberately not a parallel
 * session-creation path, since a worktree's own `repoRoot` already makes
 * `@repo/review`'s session dedup key do the right thing. Synchronous, like
 * `sessions.open` itself already is: a network fetch plus a worktree
 * checkout is the same duration class as `sessions.open`'s own `gh` round
 * trips, not the open-ended, multi-step kind `walkthrough.generate`'s
 * streaming handler exists for — see that procedure's own doc for the
 * distinction. Its five error codes cover `openPullRequestWorktree`'s four
 * tagged errors (no remote to fetch from, a PR ref that doesn't exist, this
 * PR's branch busy in another worktree, a stray directory in the way) plus
 * `gh` failing to resolve the PR number itself or to reach GitHub at all —
 * see `apps/desktop/sidecar/http.ts`'s handler for the mapping.
 *
 * `recordRepoPath` is the other half of the `"needs-repo-path"` flow: the
 * frontend calls it once the user's picked a folder in the native dialog,
 * with `BAD_REQUEST` covering every way `@repo/git`'s
 * `verifyRepoPathMatchesOrigin` can reject the folder itself (doesn't exist,
 * isn't a git repo, no `origin` remote, or `origin` resolves to a different
 * `owner/repo` — the message names which) and `SERVICE_UNAVAILABLE` covering
 * `git` failing to run at all. Persists nothing on failure; on success, the
 * frontend calls `open` again, which now resolves without a fresh prompt.
 *
 * `mergeStatus`/`merge` back the PR header's Merge button. `mergeStatus`
 * combines `@repo/git`'s `fetchPullRequestMergeability` and
 * `fetchRepoMergeMethods` into one round trip — the button needs both to
 * decide its label/enabled state and its method picker at once, and they're
 * independent `gh` calls with no reason to force two round trips where one
 * will do. `MERGE_STATUS_UNAVAILABLE` is the one error code that isn't
 * shared with `search`/`open`: `mergeStateStatus` specifically requires push
 * access to the repo, and a caller without it gets this rather than a
 * silently substituted `"UNKNOWN"` — see `PullRequestMergeStatusUnavailable`
 * in `@repo/git`. `merge` fires `gh pr merge` with the caller's chosen
 * method; `CONFLICT` covers a PR that genuinely isn't mergeable right now
 * (conflicts, a blocked/required check, behind base), distinct from the
 * generic `SERVICE_UNAVAILABLE` a `gh` failure that isn't auth/not-found/
 * not-mergeable falls back to. See `apps/desktop/sidecar/http.ts`'s handlers
 * for the full error mapping.
 *
 * `checks` backs the PR header's `CiStatus` ring — `@repo/git`'s
 * `fetchPullRequestChecks` mapped straight through onto `PullRequestCheck`
 * above, same input shape as `mergeStatus` (only `repoRoot`/`number`
 * actually drive the underlying `gh pr view`, but `owner`/`repo` are kept
 * for consistency with every other per-PR procedure here). Its three error
 * codes mirror `mergeStatus`'s PR-scoped subset (no
 * `MERGE_STATUS_UNAVAILABLE` — nothing here needs push access) — see
 * `apps/desktop/sidecar/http.ts`'s handler for the mapping. A PR with no CI
 * configured legitimately resolves to an empty array, which `CiStatus`
 * already renders as nothing rather than an empty ring. Turning
 * `durationMs` into `CiStatus`'s human-readable `detail` string is left to
 * `apps/desktop/src/components/pr/pr-ci-status.tsx` — this wire shape
 * carries the fact, not the formatting.
 *
 * `unpushedCommits` backs the pre-merge "you have local unpushed commits"
 * check — unlike every other procedure here, it's about the *local*
 * worktree branch, not the PR itself, so its input is just `repoRoot`
 * (whatever branch is actually checked out there). Wraps `@repo/git`'s
 * `resolveUnpushedCommitCount`; `NO_REMOTE_REF` is that function's one
 * failure mode — no `@{upstream}` and no matching `origin/<branch>`, so
 * there's genuinely nothing to compare `HEAD` against — kept distinct from
 * `SERVICE_UNAVAILABLE` (a `git` command itself failing to run) since the
 * frontend shows a different dialog for each.
 *
 * `markReady` fires `gh pr ready`, flipping a draft PR to ready for review —
 * backs the PR header overflow menu's own item, shown only while
 * `mergeStatus.isDraft` is true. Input is just `repoRoot`/`number` (unlike
 * `merge`, `gh pr ready` needs no method); the frontend still invalidates
 * `mergeStatus` on success the same way `merge` does, since `isDraft` drives
 * both that menu item's visibility and the merge button's own draft label.
 * Error codes mirror `merge`'s minus `CONFLICT` — readiness doesn't depend on
 * mergeability, so there's no analogous "not mergeable right now" outcome.
 */
export const pullRequestsContract = {
	search: oc
		.input(Schema.Struct({ query: Schema.String }))
		.output(Schema.Array(PullRequestSearchResult))
		.errors({
			GH_NOT_AUTHENTICATED: {},
			TOO_MANY_REQUESTS: {},
			SERVICE_UNAVAILABLE: {},
		}),
	open: oc
		.input(
			Schema.Struct({
				owner: Schema.String,
				repo: Schema.String,
				number: Schema.Number,
			}),
		)
		.output(OpenPullRequestOutcome)
		.errors({
			BAD_REQUEST: {},
			NOT_FOUND: {},
			CONFLICT: {},
			PRECONDITION_FAILED: {},
			SERVICE_UNAVAILABLE: {},
		}),
	recordRepoPath: oc
		.input(
			Schema.Struct({
				owner: Schema.String,
				repo: Schema.String,
				path: Schema.String,
			}),
		)
		.output(RepoPathMapping)
		.errors({ BAD_REQUEST: {}, SERVICE_UNAVAILABLE: {} }),
	mergeStatus: oc
		.input(
			Schema.Struct({
				repoRoot: Schema.String,
				owner: Schema.String,
				repo: Schema.String,
				number: Schema.Number,
			}),
		)
		.output(PullRequestMergeStatus)
		.errors({
			GH_NOT_AUTHENTICATED: {},
			TOO_MANY_REQUESTS: {},
			SERVICE_UNAVAILABLE: {},
			NOT_FOUND: {},
			MERGE_STATUS_UNAVAILABLE: {},
		}),
	merge: oc
		.input(
			Schema.Struct({
				repoRoot: Schema.String,
				owner: Schema.String,
				repo: Schema.String,
				number: Schema.Number,
				method: MergeMethod,
			}),
		)
		.output(Schema.Void)
		.errors({
			CONFLICT: {},
			GH_NOT_AUTHENTICATED: {},
			NOT_FOUND: {},
			SERVICE_UNAVAILABLE: {},
		}),
	markReady: oc
		.input(
			Schema.Struct({
				repoRoot: Schema.String,
				number: Schema.Number,
			}),
		)
		.output(Schema.Void)
		.errors({
			GH_NOT_AUTHENTICATED: {},
			NOT_FOUND: {},
			SERVICE_UNAVAILABLE: {},
		}),
	checks: oc
		.input(
			Schema.Struct({
				repoRoot: Schema.String,
				owner: Schema.String,
				repo: Schema.String,
				number: Schema.Number,
			}),
		)
		.output(Schema.Array(PullRequestCheck))
		.errors({
			GH_NOT_AUTHENTICATED: {},
			TOO_MANY_REQUESTS: {},
			SERVICE_UNAVAILABLE: {},
			NOT_FOUND: {},
		}),
	unpushedCommits: oc
		.input(Schema.Struct({ repoRoot: Schema.String }))
		.output(UnpushedCommits)
		.errors({
			NO_REMOTE_REF: {},
			SERVICE_UNAVAILABLE: {},
		}),
};
