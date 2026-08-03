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
};
