import { join } from "node:path";
import {
	diffContentsPatch,
	type FileContentRequest,
	type GhOutputDecodeError,
	type GitCommandError,
	type FileChange as GitFileChange,
	type FileContent as GitFileContent,
	type GitHubTarget,
	type GitHubUnreachable,
	getChangedFiles,
	getFileContents,
	inferRepoPath,
	type NoDefaultBranch,
	type NoOriginRemote,
	openPullRequestWorktree,
	type PullRequestNotFound,
	type PullRequestRefNotFound,
	type RepoPathVerificationError,
	readFileContentsAtRef,
	readWorktreeBlobContent,
	resolveCurrentBranch,
	resolveHeadSha,
	resolveMergeBase,
	resolvePullRequestHeadRef,
	resolveRepoRoot,
	resolveReviewTarget,
	resolveReviewTargetForPullRequest,
	revalidateWorktreePath,
	verifyRepoPathMatchesOrigin,
	type WorktreeBranchInUse,
	type WorktreePathOccupied,
	type WorktreeReadFailed,
	type WorktreeRelocationFailed,
} from "@repo/git";
import {
	type FileReviewState,
	hashContent,
	hasUnreviewedRanges,
	type RangeReviewClaim,
	type Reconciliation,
	type ReviewClaim,
	type Session as ReviewSession,
	ReviewStore,
	type ReviewStoreError,
	reconcile,
	resolveReviewState,
	SessionNotFound,
	type SessionPullRequest,
} from "@repo/review";
import { SettingsStore, type SettingsStoreError } from "@repo/settings";
import { Context, Effect, Layer, Option, Schema } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";

/** `sessions.open`'s `cwd` doesn't resolve to a git working tree. */
export class InvalidCwd extends Schema.TaggedErrorClass<InvalidCwd>()(
	"InvalidCwd",
	{
		cwd: Schema.String,
	},
) {}

/** `sessions.open`'s `target: { kind: "pr" }` asked for a PR, but `resolveReviewTarget` found none open for the current branch. */
export class NoPullRequest extends Schema.TaggedErrorClass<NoPullRequest>()(
	"NoPullRequest",
	{
		repoRoot: Schema.String,
	},
) {}

/** `sessions.open`'s `target: { kind: "branch", baseRef }` named a ref `git` couldn't resolve — typically a typo. `stderr` is git's own explanation, carried through so the caller sees which ref was bad instead of a generic "invalid base". */
export class InvalidBaseRef extends Schema.TaggedErrorClass<InvalidBaseRef>()(
	"InvalidBaseRef",
	{
		repoRoot: Schema.String,
		baseRef: Schema.String,
		stderr: Schema.String,
	},
) {}

/** `sessions.open`'s `target: { kind: "branch", headRef }` (the range-spelling form of `nisi diff <base>..<head>`) named a ref `git` couldn't resolve. Mirrors `InvalidBaseRef` — kept as its own tag rather than reusing it so a typo on either side of the range is attributed to the ref that was actually bad. */
export class InvalidHeadRef extends Schema.TaggedErrorClass<InvalidHeadRef>()(
	"InvalidHeadRef",
	{
		repoRoot: Schema.String,
		headRef: Schema.String,
		stderr: Schema.String,
	},
) {}


/**
 * `sessions.open`'s target selector — mirrors `packages/sidecar-api`'s
 * `OpenSessionTarget`, plus one variant that never crosses the wire:
 * `"specificPullRequest"` is constructed only by `openPullRequestSession`
 * below, for a PR the caller already identified by number rather than one
 * `sessions.open`'s own contract input can ask for — see
 * `resolveSessionTarget`'s doc comment for why it needs its own resolution
 * path instead of reusing `"pr"`.
 */
export type OpenSessionTarget =
	| { readonly kind: "auto" }
	| { readonly kind: "pr" }
	| { readonly kind: "specificPullRequest"; readonly number: number }
	| {
			readonly kind: "branch";
			readonly baseRef?: string;
			readonly headRef?: string;
	  };

export type SessionTarget =
	| {
			readonly kind: "pr";
			readonly number: number;
			readonly title: string;
			readonly baseRef: string;
			readonly headRef: string;
			readonly owner: string;
			readonly repo: string;
	  }
	| {
			readonly kind: "branch";
			readonly baseRef: string;
			readonly headRef: string;
	  };

export type Session = {
	readonly id: string;
	readonly repoRoot: string;
	readonly target: SessionTarget;
};

/** `pullRequests.open`'s input — the palette only ever knows `owner/repo#number`, never a local path; see `openPullRequestSession`'s doc for how the rest gets resolved. */
export type OpenPullRequestInput = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};

/** Mirrors `packages/sidecar-api`'s `OpenPullRequestOutcome` — see that contract's doc for why this is a discriminated union rather than a separate pre-flight route. */
export type OpenPullRequestOutcome =
	| { readonly status: "opened"; readonly session: Session }
	| {
			readonly status: "needs-repo-path";
			readonly owner: string;
			readonly repo: string;
	  };

export type FileReview = {
	readonly viewed: boolean;
	readonly reviewedHash: string | null;
	readonly changedSinceReview: boolean;
};

/** `@repo/git`'s `FileChange` plus the review state Phase 1 shipped write-only — see `attachReviewState`. */
export type FileChange = GitFileChange & { readonly review: FileReview | null };

/** `@repo/git`'s `FileContent` plus Phase 2's reconciliation — see `readFileContents`. */
export type FileContent = GitFileContent & {
	readonly review: Reconciliation | null;
};

/** One path within a `readFileContents` batch request — mirrors `packages/sidecar-api`'s `FileContentRequest`, minus the wire encoding. */
export type FileContentBatchRequest = {
	readonly path: string;
	readonly oldPath?: string;
	readonly force: boolean;
};

/** One path's result within a `readFileContents` batch — `content` is `null` when the path turned out not to be part of the diff. */
export type FileContentBatchResult = {
	readonly path: string;
	readonly content: FileContent | null;
};

/**
 * Narrows a whole-file review row down to the shape `readFileContents`
 * actually needs — `null` unless it's a real, ticked "viewed" row.
 * `snapshotHash` itself can be `null` on a real claim: that means the file
 * was absent from the working tree at tick time (see `@repo/review`'s
 * `markFileViewed` and `reviewedFiles.snapshotHash`'s column comment) —
 * callers must compare it explicitly rather than assume a hash string.
 */
const toActiveFileClaim = (
	state: FileReviewState | null,
): {
	readonly snapshotHash: string | null;
	readonly viewedAt: number;
} | null => {
	if (state === null || !state.viewed) return null;
	return { snapshotHash: state.snapshotHash, viewedAt: state.viewedAt };
};

/**
 * A session's PR only exists when GitHub knows this repo *and* has an open PR
 * for the current branch — every other case (no remote, a non-GitHub remote,
 * an origin GitHub can't resolve, a branch with no PR) reviews against the
 * default branch instead. See `@repo/git`'s `resolveReviewTarget`.
 */
const toSessionPullRequest = (
	github: GitHubTarget | null,
): SessionPullRequest | null =>
	github === null || github.pr === null
		? null
		: {
				number: github.pr.number,
				title: github.pr.title,
				owner: github.owner,
				repo: github.repo,
			};

const toWireSession = (session: ReviewSession): Session => ({
	id: session.id,
	repoRoot: session.repoRoot,
	target:
		session.pr === null
			? { kind: "branch", baseRef: session.baseRef, headRef: session.headRef }
			: {
					kind: "pr",
					number: session.pr.number,
					title: session.pr.title,
					baseRef: session.baseRef,
					headRef: session.headRef,
					owner: session.pr.owner,
					repo: session.pr.repo,
				},
});

/**
 * Resolves what `target` actually means for `repoRoot` right now — the
 * `@repo/review` inputs `openSession` needs (`baseRef`/`headRef`/`pr`), one
 * per selector variant:
 *
 * - `"branch"` with an explicit `baseRef` is a pure local diff and skips
 *   `resolveReviewTarget` (and therefore any GitHub round trip) entirely —
 *   the caller named its own base, there's nothing to look up. `baseRef` is
 *   still validated via `resolveMergeBase`, the same resolution
 *   `getChangedFiles`/`getFileContents` would do anyway, just run here so a
 *   typo'd ref fails the request (`InvalidBaseRef`) before a session is ever
 *   persisted, instead of surfacing as an opaque error the first time Files
 *   Changed loads. An explicit `headRef` alongside it — the CLI's range
 *   spelling, `nisi diff <base>..<head>`/`nisi diff <base>...<head>` (both
 *   mean the same thing here, see `packages/cli`'s `parseBaseArgument`) — is
 *   validated the same way (`InvalidHeadRef`) and used as-is, in place of the
 *   current checkout. See this function's closing paragraph for why an
 *   explicit head changes more than just which commit gets diffed.
 * - `"branch"` with no `baseRef` falls back to the repo's default branch,
 *   still ignoring any PR open on the current branch — not re-validated,
 *   since `resolveReviewTarget`'s own resolution is git-derived by
 *   construction. `headRef` is always the current checkout here (an explicit
 *   `headRef` with no `baseRef` never happens from the CLI — the two are
 *   parsed from the same `<base>` argument together, see `packages/cli/src/index.ts`).
 * - `"pr"` requires a PR *for the current branch*: `resolveReviewTarget`
 *   finding none fails with `NoPullRequest` rather than silently degrading
 *   to a branch diff the caller didn't ask for.
 * - `"specificPullRequest"` requires a PR *by number*, regardless of what's
 *   checked out — what `openPullRequestSession` below uses once it already
 *   knows which PR it's opening. Unlike `"pr"`, this doesn't derive the PR
 *   from the current branch at all: `openPullRequestWorktree` checks a PR
 *   out into a nisi-local branch (`nisi/pr-<n>/<headRef>`) that doesn't
 *   exist on `origin`, so `gh pr view` with no arguments could never
 *   resolve it. `resolveReviewTargetForPullRequest` fails outright
 *   (`PullRequestNotFound`) rather than degrading when the number `gh`
 *   can't resolve, since the caller explicitly picked this PR — that
 *   failure must surface, not disappear into a no-PR session.
 * - `"auto"` is today's behavior — PR if one's open, else the default
 *   branch.
 *
 * Head is the current checkout (`resolveCurrentBranch`, or the PR's own
 * `headRefName` for any of the PR-resolving variants when a PR is in play)
 * for every variant except `"branch"` with an explicit `headRef` — the one
 * case where `repoRoot`'s worktree isn't guaranteed to actually be sitting on
 * `headRef` at all (the CLI runs from whatever the caller currently has
 * checked out, which may be neither side of the diff). But even an ordinary
 * session can drift: `headRef` is resolved once, here, at open time, while
 * the caller's actual checkout can change for as long as the session stays
 * open. Every git call against a session — every read
 * (`listChangedFiles`/`readFileContents`) and every write
 * (`setFileViewed`/`setRangeViewed`) alike — must re-derive whether the
 * worktree is still trustworthy rather than assume this function's answer
 * still holds; see `resolveDiffHead` below, which every one of them
 * consults independently.
 */
const resolveSessionTarget = (repoRoot: string, target: OpenSessionTarget) =>
	Effect.gen(function* () {
		if (target.kind === "branch" && target.baseRef !== undefined) {
			const baseRef = target.baseRef;
			const explicitHeadRef = target.headRef;

			if (explicitHeadRef !== undefined) {
				yield* resolveHeadSha(repoRoot, explicitHeadRef).pipe(
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.fail(
							new InvalidHeadRef({
								repoRoot,
								headRef: explicitHeadRef,
								stderr: cause.stderr,
							}),
						),
					),
				);
			}

			yield* resolveMergeBase(repoRoot, baseRef, explicitHeadRef).pipe(
				Effect.catchTag("GitCommandError", (cause) =>
					Effect.fail(
						new InvalidBaseRef({ repoRoot, baseRef, stderr: cause.stderr }),
					),
				),
			);
			const headRef =
				explicitHeadRef ?? (yield* resolveCurrentBranch(repoRoot));
			return { baseRef, headRef, pr: null };
		}

		if (target.kind === "specificPullRequest") {
			const [reviewTarget, currentBranch] = yield* Effect.all([
				resolveReviewTargetForPullRequest(repoRoot, target.number),
				resolveCurrentBranch(repoRoot),
			]);
			const githubPr = reviewTarget.github?.pr ?? null;
			return {
				baseRef: githubPr?.baseRef ?? reviewTarget.defaultBranch,
				headRef: githubPr?.headRef ?? currentBranch,
				pr: toSessionPullRequest(reviewTarget.github),
			};
		}

		const [reviewTarget, currentBranch] = yield* Effect.all([
			resolveReviewTarget(repoRoot),
			resolveCurrentBranch(repoRoot),
		]);

		if (target.kind === "branch") {
			return {
				baseRef: reviewTarget.defaultBranch,
				headRef: currentBranch,
				pr: null,
			};
		}

		const githubPr = reviewTarget.github?.pr ?? null;

		if (target.kind === "pr") {
			if (githubPr === null) {
				return yield* new NoPullRequest({ repoRoot });
			}
			return {
				baseRef: githubPr.baseRef,
				headRef: githubPr.headRef,
				pr: toSessionPullRequest(reviewTarget.github),
			};
		}

		return {
			baseRef: githubPr?.baseRef ?? reviewTarget.defaultBranch,
			headRef: githubPr?.headRef ?? currentBranch,
			pr: toSessionPullRequest(reviewTarget.github),
		};
	});

/**
 * Combines `@repo/git` (pure PR/diff detection) and `@repo/review`
 * (persistence) into the one service the sidecar's oRPC handlers depend on.
 * Sessions are `@repo/review`'s row plus `@repo/git`'s resolution of what
 * that row's `repoRoot`/PR state actually *is* right now.
 */
export class Store extends Context.Service<Store>()("Store", {
	make: Effect.gen(function* () {
		const reviewStore = yield* ReviewStore;
		const settingsStore = yield* SettingsStore;

		const openSession = (
			cwd: string,
			target: OpenSessionTarget = { kind: "auto" },
		) =>
			Effect.gen(function* () {
				const repoRoot = yield* resolveRepoRoot(cwd).pipe(
					Effect.catchTag("NotAGitRepository", () => new InvalidCwd({ cwd })),
				);
				const resolved = yield* resolveSessionTarget(repoRoot, target);
				const session = yield* reviewStore.openSession({
					repoRoot,
					baseRef: resolved.baseRef,
					headRef: resolved.headRef,
					pr: resolved.pr,
				});
				return toWireSession(session);
			});

		/**
		 * `owner/repo`'s local checkout path — a known mapping if one's already
		 * recorded, else a verified sibling-directory guess (see `@repo/git`'s
		 * `inferRepoPath`), persisted the moment it verifies so the next open
		 * of this repo skips inference entirely. `null` when neither applies:
		 * the caller (`openPullRequestSession`) turns that into the
		 * `"needs-repo-path"` outcome rather than failing — there being no
		 * known path yet is an expected, common first-time state, not an error.
		 */
		const resolveRepoPath = (owner: string, repo: string) =>
			Effect.gen(function* () {
				const known = yield* settingsStore.getRepoPath(owner, repo);
				if (known !== null) return known;

				const everyKnownPath = yield* settingsStore.listRepoPaths();
				const inferred = yield* inferRepoPath(everyKnownPath, owner, repo);
				if (inferred === null) return null;

				yield* settingsStore.setRepoPath(owner, repo, inferred);
				return inferred;
			});

		/**
		 * `session.repoRoot`, revalidated against disk and, when that fails,
		 * re-resolved via `@repo/git`'s `revalidateWorktreePath` — see that
		 * function's doc comment for why a persisted `repoRoot` can't be trusted
		 * blindly: a `git worktree move`, or an external tool (`wt`/worktrunk)
		 * relocating a worktree nisi created, leaves it pointing at a directory
		 * that no longer exists, and every git spawn against it would otherwise
		 * fail identically forever. The common case — nothing moved — costs one
		 * `stat()`, no git spawn at all.
		 *
		 * `sourceRepoRoot` for that lookup is the PR's own known main clone
		 * (`resolveRepoPath` above, same lookup `openPullRequestSession` uses) —
		 * `null` for a no-PR branch session, which has no second path to consult
		 * at all. When resolution lands on a path other than what's persisted,
		 * this writes it back (`ReviewStore.updateRepoRoot`) so every other
		 * caller — including the next live-poll tick — sees the healed path too,
		 * not just this one call.
		 */
		const resolveLiveRepoRoot = (
			session: ReviewSession,
		): Effect.Effect<
			string,
			| GitCommandError
			| WorktreeRelocationFailed
			| SettingsStoreError
			| SessionNotFound
			| ReviewStoreError,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const liveRepoRoot = yield* revalidateWorktreePath({
					path: session.repoRoot,
					headRef: session.headRef,
					number: session.pr?.number ?? null,
					resolveSourceRepoRoot:
						session.pr === null
							? Effect.succeed(null)
							: resolveRepoPath(session.pr.owner, session.pr.repo),
				});

				if (liveRepoRoot !== session.repoRoot) {
					yield* reviewStore.updateRepoRoot(session.id, liveRepoRoot);
				}
				return liveRepoRoot;
			});

		/**
		 * The public, sessionId-keyed sibling of {@link resolveLiveRepoRoot} —
		 * what `live-poll.ts`'s `checkSessionForChanges` calls, since it only
		 * ever has a session id to start from, not an already-fetched session row.
		 */
		const resolveSessionRepoRoot = (
			sessionId: string,
		): Effect.Effect<
			string,
			| SessionNotFound
			| ReviewStoreError
			| GitCommandError
			| WorktreeRelocationFailed
			| SettingsStoreError,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				return yield* resolveLiveRepoRoot(session);
			});

		/**
		 * The palette's "open this PR" action. Resolves `owner/repo` to a local
		 * checkout first (`resolveRepoPath` above) — the palette never knows a
		 * path itself, only `owner/repo#number` (`gh search prs` can't return
		 * ref names either, see `@repo/git`'s `PullRequestSearchResult` doc) —
		 * short-circuiting to `"needs-repo-path"` when nothing resolves, then
		 * resolves the PR's `headRef` (`resolvePullRequestHeadRef`, needed
		 * *before* the worktree exists to name its branch) and create-or-reuses
		 * a worktree for it (`@repo/git`'s `openPullRequestWorktree`, idempotent
		 * from git's own `worktree list` registration). Finally opens a session
		 * against the worktree with `{ kind: "specificPullRequest" }` — the
		 * worktree's own path becomes the session's `cwd`, and
		 * `resolveSessionTarget` resolves the PR *by the number the caller
		 * already knows* rather than re-deriving it from the worktree's
		 * checked-out branch (see that function's doc comment for why a plain
		 * `"auto"`/`"pr"` open could never resolve it). Not a parallel
		 * session-creation path — routes through the same `openSession` every
		 * other caller uses, so a worktree's own `repoRoot` makes
		 * `@repo/review`'s session dedup key do the right thing, the same way
		 * two independent clones of one upstream already get independent
		 * sessions.
		 */
		const openPullRequestSession = (
			input: OpenPullRequestInput,
		): Effect.Effect<
			OpenPullRequestOutcome,
			| GitCommandError
			| GhOutputDecodeError
			| PullRequestNotFound
			| NoOriginRemote
			| PullRequestRefNotFound
			| WorktreeBranchInUse
			| WorktreePathOccupied
			| NoDefaultBranch
			| GitHubUnreachable
			| InvalidCwd
			| InvalidBaseRef
			| InvalidHeadRef
			| NoPullRequest
			| ReviewStoreError
			| SettingsStoreError,
			ChildProcessSpawner.ChildProcessSpawner | FileSystem
		> =>
			Effect.gen(function* () {
				const repoRoot = yield* resolveRepoPath(input.owner, input.repo);
				if (repoRoot === null) {
					return {
						status: "needs-repo-path" as const,
						owner: input.owner,
						repo: input.repo,
					};
				}

				const headRef = yield* resolvePullRequestHeadRef(
					repoRoot,
					input.number,
				);
				const worktreePath = yield* openPullRequestWorktree({
					repoRoot,
					number: input.number,
					headRef,
				});
				const session = yield* openSession(worktreePath, {
					kind: "specificPullRequest",
					number: input.number,
				});
				return { status: "opened" as const, session };
			});

		/**
		 * The other half of the `"needs-repo-path"` flow: persists the local
		 * folder the user picked for `owner/repo`, but only once
		 * `verifyRepoPathMatchesOrigin` confirms its `origin` remote actually
		 * resolves to that `owner/repo` — a user-picked folder gets exactly the
		 * same gate a silent inference guess does, so picking the wrong folder
		 * fails loudly here rather than quietly opening the wrong repo's code
		 * on the next `open`. What's persisted (and returned) is
		 * `verifyRepoPathMatchesOrigin`'s normalized main-clone root, not the
		 * raw folder the user picked — a subdirectory or a worktree the picker
		 * let them choose still ends up mapped to the repo's real home on disk,
		 * the same normalization `resolveRepoPath`'s inference path applies.
		 */
		const recordRepoPath = (
			owner: string,
			repo: string,
			path: string,
		): Effect.Effect<
			{ readonly owner: string; readonly repo: string; readonly path: string },
			RepoPathVerificationError | GitCommandError | SettingsStoreError,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const repoRoot = yield* verifyRepoPathMatchesOrigin(path, owner, repo);
				yield* settingsStore.setRepoPath(owner, repo, repoRoot);
				return { owner, repo, path: repoRoot };
			});

		const listSessions = () =>
			reviewStore
				.listOpenSessions()
				.pipe(Effect.map((sessions) => sessions.map(toWireSession)));

		const closeSession = (sessionId: string) =>
			reviewStore.closeSession(sessionId);

		/**
		 * Hashes each of `paths`' *current* content the same way a review
		 * snapshot is hashed (`@repo/review`'s `hashContent`, SHA-256 of raw
		 * bytes — not a git object id, which wouldn't compare against a stored
		 * `snapshotHash` at all), so the caller can tell a ticked file's snapshot
		 * apart from what's actually there now. What "current" means follows
		 * `includeUncommitted`: worktree bytes (`@repo/git`'s
		 * `readWorktreeBlobContent`, one call per path — cheap enough locally
		 * that batching buys nothing) when `true`, HEAD's tree (`@repo/git`'s
		 * `readFileContentsAtRef`, one batched `cat-file --batch` call over
		 * every path) when `false`. Either way this only ever runs over the
		 * paths the caller actually asks for — scoped to files with active
		 * review state by both call sites below, not the diff's total size. A
		 * path missing either way (deleted since review, or never existed at
		 * HEAD) is simply absent from the returned map — not a swallowed
		 * error; both call sites below already apply the "diff against
		 * /dev/null" `?? hashContent(new Uint8Array())` fallback where an
		 * absent entry needs to compare as empty content, the same convention
		 * `setFileViewed`/`@repo/review`'s `reconcile` use. A genuine read
		 * failure (permissions, a directory in the file's place, ...)
		 * propagates as `WorktreeReadFailed` instead of collapsing into
		 * either case.
		 */
		const readCurrentHashes = (
			repoRoot: string,
			includeUncommitted: boolean,
			paths: ReadonlyArray<string>,
			/** The ref committed-mode hashes against — defaults to `HEAD`, the current checkout. See `resolveDiffHead` for when this needs to be a session's own explicit `headRef` instead. */
			headRef = "HEAD",
		): Effect.Effect<
			ReadonlyMap<string, string>,
			GitCommandError | WorktreeReadFailed,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				if (includeUncommitted) {
					const entries = yield* Effect.forEach(
						paths,
						(path) =>
							readWorktreeBlobContent(join(repoRoot, path)).pipe(
								Effect.map((content) => [path, content] as const),
							),
						{ concurrency: "unbounded" },
					);
					const hashes = new Map<string, string>();
					for (const [path, content] of entries) {
						if (Option.isSome(content)) {
							hashes.set(path, hashContent(content.value));
						}
					}
					return hashes;
				}

				const contents = yield* readFileContentsAtRef(repoRoot, headRef, paths);
				return new Map(
					[...contents].map(
						([path, bytes]) => [path, hashContent(bytes)] as const,
					),
				);
			});

		/**
		 * Attaches each file's review state, looked up by its current path with
		 * a fallback to `oldPath` for a rename (a rename's `reviewed_files` row
		 * still lives under the pre-rename path — see `resolveReviewState`).
		 * `changedSinceReview` costs one `readCurrentHashes` batch over only the
		 * files that actually have review state — bounded by how many files the
		 * user has ticked, not by the diff's total size, unlike the live-update
		 * poller's mtime/size-first discipline (which has to scan every changed
		 * file on every tick regardless of review state).
		 */
		const attachReviewState = (
			sessionId: string,
			repoRoot: string,
			includeUncommitted: boolean,
			files: ReadonlyArray<GitFileChange>,
			/** See `readCurrentHashes` — threaded through for a session whose `headRef` isn't the current checkout. */
			headRef?: string,
		): Effect.Effect<
			ReadonlyArray<FileChange>,
			SessionNotFound | ReviewStoreError | GitCommandError | WorktreeReadFailed,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const states = yield* reviewStore.listReviewStates(sessionId);

				const claims = new Map<
					string,
					{ readonly snapshotHash: string | null; readonly viewedAt: number }
				>();
				for (const file of files) {
					const claim = toActiveFileClaim(
						resolveReviewState(states, file.path, file.oldPath),
					);
					if (claim !== null) claims.set(file.path, claim);
				}

				const currentHashes = yield* readCurrentHashes(
					repoRoot,
					includeUncommitted,
					[...claims.keys()],
					headRef,
				);

				return files.map((file) => {
					const claim = claims.get(file.path);
					if (claim === undefined) return { ...file, review: null };
					// `claim.snapshotHash === null` means this file was reviewed
					// while absent from the working tree — there's no hash to
					// compare against (`null` isn't `sha256("")`), so "changed"
					// means "the file exists now" rather than a hash mismatch; a
					// still-absent file (not in `currentHashes`, see
					// `readCurrentHashes`) keeps its tick.
					const review: FileReview =
						claim.snapshotHash === null
							? {
									viewed: true,
									reviewedHash: null,
									changedSinceReview: currentHashes.has(file.path),
								}
							: {
									viewed: true,
									reviewedHash: claim.snapshotHash,
									changedSinceReview:
										(currentHashes.get(file.path) ??
											hashContent(new Uint8Array())) !== claim.snapshotHash,
								};
					return { ...file, review };
				});
			});

		/**
		 * What every git call against `session` should treat as its head, plus
		 * whether it's safe to overlay `repoRoot`'s worktree on top of it at
		 * all — consulted by every read (`listChangedFiles`/`readFileContents`)
		 * and write (`setFileViewed`/`setRangeViewed`) path that touches a
		 * session's files, so the two can never disagree about which commit
		 * "head" means right now.
		 *
		 * A PR-backed session (`session.pr !== null`) is always worktree-
		 * eligible without even checking: its `repoRoot` is a worktree nisi
		 * created and keeps checked out to exactly this PR's head (see
		 * `@repo/git`'s `worktree.ts`) — and `session.headRef` there is the PR
		 * author's own branch name, which isn't guaranteed to resolve as a ref
		 * in that worktree at all (nisi checks the PR out onto its own
		 * `nisi/pr-<n>/<headRef>` branch), so it must never be passed to
		 * `getChangedFiles`/`getFileContents` as an explicit `headRef` either
		 * — literal `HEAD` is already the right target.
		 *
		 * A plain branch session (`session.pr === null`) compares
		 * `session.headRef` against what's actually checked out right now
		 * (`resolveCurrentBranch`) — not stored once at open time — so a
		 * session drifts in and out of worktree-eligibility as the caller
		 * checks different branches out, rather than staying pinned to
		 * whatever was true when the session opened. This covers both
		 * directions: an explicit, never-checked-out head (`nisi diff
		 * <base>..<head>`) starts ineligible and self-heals the moment the
		 * caller checks it out; an ordinary session (`headRef` equal to the
		 * checkout at open time) goes ineligible the moment the caller checks
		 * out something else — every subsequent read *and write* must follow
		 * that, not keep treating the worktree as if it still belonged to
		 * this session.
		 */
		const resolveDiffHead = (
			session: ReviewSession,
			repoRoot: string,
		): Effect.Effect<
			{
				readonly headRef: string | undefined;
				readonly worktreeEligible: boolean;
			},
			GitCommandError,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			session.pr !== null
				? Effect.succeed({ headRef: undefined, worktreeEligible: true })
				: resolveCurrentBranch(repoRoot).pipe(
						Effect.map((currentBranch) => {
							const worktreeEligible = currentBranch === session.headRef;
							return {
								headRef: worktreeEligible ? undefined : session.headRef,
								worktreeEligible,
							};
						}),
					);

		/**
		 * `path`'s content right now, per `diffHead`: worktree bytes when
		 * eligible (`readWorktreeBlobContent`, same as every write path used
		 * unconditionally before `resolveDiffHead` existed), or `diffHead
		 * .headRef`'s own committed blob otherwise (`@repo/git`'s
		 * `readFileContentsAtRef`) — never the live worktree, which for an
		 * ineligible session belongs to a different branch entirely. Shared by
		 * every read (`readCurrentHashes`, inlined there) and write
		 * (`setFileViewed`/`setRangeViewed`) path that needs "what does this
		 * path look like right now" rather than a full diff.
		 */
		const readCurrentBlobContent = (
			repoRoot: string,
			path: string,
			diffHead: {
				readonly headRef: string | undefined;
				readonly worktreeEligible: boolean;
			},
		): Effect.Effect<
			Option.Option<Uint8Array>,
			WorktreeReadFailed | GitCommandError,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			diffHead.worktreeEligible
				? readWorktreeBlobContent(join(repoRoot, path))
				: readFileContentsAtRef(repoRoot, diffHead.headRef ?? "HEAD", [
						path,
					]).pipe(
						Effect.map((contents) => Option.fromNullishOr(contents.get(path))),
					);

		const listChangedFiles = (sessionId: string, includeUncommitted: boolean) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const diffHead = yield* resolveDiffHead(session, repoRoot);
				const effectiveIncludeUncommitted =
					includeUncommitted && diffHead.worktreeEligible;
				const files = yield* getChangedFiles(repoRoot, session.baseRef, {
					includeUncommitted: effectiveIncludeUncommitted,
					headRef: diffHead.headRef,
				});
				return yield* attachReviewState(
					sessionId,
					repoRoot,
					effectiveIncludeUncommitted,
					files,
					diffHead.headRef,
				);
			});

		/**
		 * Range claims looked up by the file's current path, falling back to
		 * `oldPath` when the current path has none — same rename-survival
		 * reasoning as `resolveReviewState`, just for a list rather than a
		 * single row (`ReviewStore.listRangeClaims` is path-scoped, so a rename
		 * needs a second query rather than a map lookup).
		 */
		const resolveRangeClaims = (
			sessionId: string,
			path: string,
			oldPath: string | undefined,
		): Effect.Effect<
			ReadonlyArray<RangeReviewClaim>,
			SessionNotFound | ReviewStoreError
		> =>
			Effect.gen(function* () {
				const claims = yield* reviewStore.listRangeClaims(sessionId, path);
				if (claims.length > 0 || oldPath === undefined) return claims;
				return yield* reviewStore.listRangeClaims(sessionId, oldPath);
			});

		/**
		 * Builds `reconcile`'s claim list for one file: the whole-file claim
		 * (when ticked) plus every block-scoped range claim, each carrying its
		 * own snapshot content read back out of the blob store.
		 */
		const buildReviewClaims = (
			fileState: {
				readonly snapshotHash: string | null;
				readonly viewedAt: number;
			} | null,
			rangeClaims: ReadonlyArray<RangeReviewClaim>,
		): Effect.Effect<
			ReadonlyArray<ReviewClaim>,
			ReviewStoreError,
			FileSystem
		> =>
			Effect.gen(function* () {
				const fileClaim: ReviewClaim | null =
					fileState === null
						? null
						: {
								source: { kind: "file" },
								// `snapshotHash === null` means the file was absent when
								// this claim was ticked — there's no blob to read back,
								// so its snapshot content is `""`, the same "missing
								// content at any state is empty" convention
								// `@repo/review`'s `reconcile` already documents.
								snapshotContent:
									fileState.snapshotHash === null
										? ""
										: new TextDecoder().decode(
												yield* reviewStore.readSnapshot(fileState.snapshotHash),
											),
								ranges: null,
								viewedAt: fileState.viewedAt,
							};

				const rangeClaimEffects = yield* Effect.forEach(
					rangeClaims,
					(claim) =>
						Effect.gen(function* () {
							const snapshotContent = new TextDecoder().decode(
								yield* reviewStore.readSnapshot(claim.snapshotHash),
							);
							const reviewClaim: ReviewClaim = {
								source: {
									kind: "range",
									blockId: claim.blockId,
									blockLabel: claim.blockLabel,
								},
								snapshotContent,
								ranges: claim.ranges,
								viewedAt: claim.viewedAt,
							};
							return reviewClaim;
						}),
					{ concurrency: "unbounded" },
				);

				return fileClaim === null
					? rangeClaimEffects
					: [fileClaim, ...rangeClaimEffects];
			});

		/**
		 * The single-path gather-claims-and-reconcile step: resolves `path`'s
		 * active range claims, combines them with its (already-resolved)
		 * whole-file claim via `buildReviewClaims`, and reconciles against
		 * `baseContent`/`headContent`. Shared by `readFileContents` (below,
		 * fed the batched patch it already fetched) and `setRangeViewed`
		 * (fed worktree content directly), so a path's reconciliation is
		 * computed exactly one way regardless of caller.
		 *
		 * Returns `null` when the path has no active claim at all — reconcile
		 * would otherwise report every base→head line "new", which isn't the
		 * same as "never reviewed".
		 */
		const reconcilePathClaims = (
			sessionId: string,
			repoRoot: string,
			path: string,
			oldPath: string | undefined,
			activeFileClaim: {
				readonly snapshotHash: string | null;
				readonly viewedAt: number;
			} | null,
			baseContent: string,
			headContent: string,
		): Effect.Effect<
			Reconciliation | null,
			SessionNotFound | ReviewStoreError | GitCommandError,
			FileSystem | ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const rangeClaims = yield* resolveRangeClaims(sessionId, path, oldPath);
				if (activeFileClaim === null && rangeClaims.length === 0) return null;
				const claims = yield* buildReviewClaims(activeFileClaim, rangeClaims);
				return yield* reconcile(repoRoot, { baseContent, headContent, claims });
			});

		/**
		 * The batched sibling of the old per-path `readFileContent`: every
		 * requested path's content in one `getFileContents` call (so N files
		 * opened in the diff pane cost a constant handful of git subprocess
		 * spawns rather than N times as many — see `@repo/git`'s doc comment on
		 * that function), reconciled against review state per path exactly the
		 * same way `readFileContent` did — reconciliation itself isn't batched
		 * (`reconcile` still runs once per path, at `{ concurrency: "unbounded" }`
		 * fan-out, same as `attachReviewState` above), since it's only ever
		 * invoked for a path that actually has an active claim.
		 *
		 * A requested path absent from `getFileContents`' result (not actually
		 * part of the diff) reports `content: null` in its own result entry
		 * rather than failing the whole batch — the caller decides what that
		 * means for just that path.
		 *
		 * `oldPath` — the file's pre-rename path, when it's a rename — mirrors
		 * `FileChange.oldPath` so a rename's review state resolves the same way
		 * here as it does in `listChangedFiles`'s `attachReviewState`.
		 *
		 * `includeUncommitted` reaches `getFileContent` the same way it reaches
		 * `listChangedFiles` — gated through `resolveDiffHead` into
		 * `effectiveIncludeUncommitted` first, same as there — so
		 * `content.newContent` — and therefore `reconcile`'s
		 * `changedSinceReview`/`ranges` below — already compares against the
		 * right head (`HEAD`, or `session.headRef`'s own commit when it isn't
		 * the current checkout), not the worktree, in committed-only mode: no
		 * extra logic needed here, it falls out of threading the flag into the
		 * one content fetch this function makes. The `content.truncated`
		 * fallback just below threads the same gated flag (plus
		 * `diffHead.headRef`) through `readCurrentHashes` instead, since a
		 * size-gated file has no `content.newContent` to reuse.
		 *
		 * Reconciliation ranges are only computed when the patch content isn't
		 * size-gated (`!content.truncated`) — gated content can't be trusted
		 * for line-accurate ranges. The whole-file `changedSinceReview` hash
		 * compare doesn't have that restriction, but it only covers the
		 * whole-file claim — a size-gated file with only range claims falls back
		 * to reporting no review at all, since there's no gated equivalent for a
		 * range claim's drift.
		 */
		const readFileContents = (
			sessionId: string,
			requests: ReadonlyArray<FileContentBatchRequest>,
			includeUncommitted: boolean,
		) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const diffHead = yield* resolveDiffHead(session, repoRoot);
				const effectiveIncludeUncommitted =
					includeUncommitted && diffHead.worktreeEligible;
				const contentByPath = yield* getFileContents(
					repoRoot,
					session.baseRef,
					requests satisfies ReadonlyArray<FileContentRequest>,
					{
						includeUncommitted: effectiveIncludeUncommitted,
						headRef: diffHead.headRef,
					},
				);
				const states = yield* reviewStore.listReviewStates(sessionId);

				return yield* Effect.forEach(
					requests,
					(request) =>
						Effect.gen(function* () {
							const content = contentByPath.get(request.path);
							if (content === undefined) {
								return { path: request.path, content: null };
							}

							const fileState = resolveReviewState(
								states,
								request.path,
								request.oldPath,
							);
							const activeFileClaim = toActiveFileClaim(fileState);

							if (content.truncated) {
								if (activeFileClaim === null) {
									return {
										path: request.path,
										content: { ...content, review: null },
									};
								}
								const currentHashes = yield* readCurrentHashes(
									repoRoot,
									effectiveIncludeUncommitted,
									[request.path],
									diffHead.headRef,
								);
								// Same null-aware comparison as `attachReviewState` —
								// see its comment: a `null` `snapshotHash` means this
								// file was reviewed while absent, so "changed" means
								// "present now" rather than a hash mismatch.
								const changedSinceReview =
									activeFileClaim.snapshotHash === null
										? currentHashes.has(request.path)
										: (currentHashes.get(request.path) ??
												hashContent(new Uint8Array())) !==
											activeFileClaim.snapshotHash;
								return {
									path: request.path,
									content: {
										...content,
										review: {
											changedSinceReview,
											ranges: [],
											baselineKind: "base" as const,
										},
									},
								};
							}

							const reconciliation = yield* reconcilePathClaims(
								sessionId,
								repoRoot,
								request.path,
								request.oldPath,
								activeFileClaim,
								content.oldContent ?? "",
								content.newContent ?? "",
							);

							if (
								reconciliation === null ||
								reconciliation.reviewedBaseline === null
							) {
								return {
									path: request.path,
									content: { ...content, review: null },
								};
							}

							// Every consumer deriving a diff from the content pair
							// (`@pierre/diffs`' non-truncated render path parses
							// `oldContent`/`newContent` directly rather than `patch`
							// — see `build-file-diff.ts`) needs both sides replaced
							// together, so the patch and `oldContent` never disagree
							// about which baseline they're against.
							const reviewedPatch = yield* diffContentsPatch(
								repoRoot,
								request.path,
								reconciliation.reviewedBaseline,
								content.newContent ?? "",
							);

							return {
								path: request.path,
								content: {
									...content,
									patch: reviewedPatch,
									oldContent: reconciliation.reviewedBaseline,
									review: {
										changedSinceReview: reconciliation.changedSinceReview,
										ranges: reconciliation.ranges,
										baselineKind: "reviewed" as const,
									},
								},
							};
						}),
					{ concurrency: "unbounded" },
				);
			});

		/**
		 * Un-ticking Reviewed just clears the snapshot. Ticking it reads the
		 * file's *current* content directly via `readCurrentBlobContent` — a
		 * plain read, not `@repo/git`'s size-gated `getFileContents`, since a
		 * review snapshot's whole point is fidelity. "Current" follows
		 * `resolveDiffHead`: the live worktree when the session's head
		 * is actually what's checked out, otherwise `headRef`'s own committed
		 * blob — ticking Reviewed while the worktree belongs to a different
		 * branch must never snapshot that other branch's content. A missing
		 * file (ticking Reviewed on a deletion, or a path that never existed
		 * — either on disk or in `headRef`'s tree) persists as a `NULL`
		 * snapshot hash on a viewed row (`@repo/review`'s `markFileViewed`)
		 * rather than a `sha256("")` blob — the two are distinct claims: `NULL`
		 * means "reviewed while absent" (stays reviewed as long as it's still
		 * absent), `sha256("")` means "reviewed a genuinely empty file". A
		 * genuine read failure (permissions, a directory in the file's place)
		 * propagates instead of collapsing into either.
		 */
		const setFileViewed = (sessionId: string, path: string, viewed: boolean) =>
			Effect.gen(function* () {
				if (!viewed) {
					yield* reviewStore.markFileUnviewed(sessionId, path);
					return;
				}
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const diffHead = yield* resolveDiffHead(session, repoRoot);
				const content = yield* readCurrentBlobContent(repoRoot, path, diffHead);
				yield* reviewStore.markFileViewed(sessionId, path, content);
			});

		/**
		 * `reconcilePathClaims` fed worktree content directly instead of
		 * `getFileContents`' batched patch: fetches `path`'s content at
		 * `merge-base(baseRef, diffHead.headRef)` — the same old-side commit
		 * `getFileContents` diffs against (see its doc comment: "Old-side
		 * content is always at `mergeBase`"), never `baseRef` directly, so this
		 * reconciles against the identical base content `readFileContents`
		 * already showed the user, not a different one that happens to also be
		 * called "base". `diffHead.headRef` — `undefined` when the session is
		 * worktree-eligible, `@repo/git`'s own default already means the
		 * current checkout then; the session's own `headRef` otherwise, the
		 * same ref `headContentBytes` was actually read from (see
		 * `readCurrentBlobContent`) — keeps this call agreeing with whichever
		 * commit produced `headContentBytes` rather than silently falling
		 * back to `HEAD` regardless. Then reconciles it against
		 * `headContentBytes` (the content `setRangeViewed` already read or
		 * wrote) plus `activeFileClaim`/every other currently active range
		 * claim. Used by `setRangeViewed` to re-derive, right after a
		 * mark/unmark, whether the file's whole-file `viewed` flag should
		 * follow. Takes `repoRoot` separately from `session` — `setRangeViewed`
		 * resolves it once (via `resolveLiveRepoRoot`) and reuses it across
		 * every call this makes, rather than each one re-deriving it from
		 * `session.repoRoot` directly.
		 */
		const reconcilePathAgainstBase = (
			sessionId: string,
			session: ReviewSession,
			repoRoot: string,
			path: string,
			diffHead: {
				readonly headRef: string | undefined;
				readonly worktreeEligible: boolean;
			},
			activeFileClaim: {
				readonly snapshotHash: string | null;
				readonly viewedAt: number;
			} | null,
			headContentBytes: Uint8Array,
		): Effect.Effect<
			Reconciliation | null,
			SessionNotFound | ReviewStoreError | GitCommandError,
			FileSystem | ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const mergeBase = yield* resolveMergeBase(
					repoRoot,
					session.baseRef,
					diffHead.headRef,
				);
				const baseContentBytes = yield* readFileContentsAtRef(
					repoRoot,
					mergeBase,
					[path],
				);
				return yield* reconcilePathClaims(
					sessionId,
					repoRoot,
					path,
					undefined,
					activeFileClaim,
					new TextDecoder().decode(
						baseContentBytes.get(path) ?? new Uint8Array(),
					),
					new TextDecoder().decode(headContentBytes),
				);
			});

		/**
		 * Ticks (or unticks) one walkthrough reference block's claim — same
		 * "snapshot the whole file at tick time" discipline as `setFileViewed`,
		 * just additive (a block's claim coexists with every other block's claim
		 * and the whole-file toggle) rather than a single per-file slot.
		 *
		 * Also enforces the invariant the whole-file `viewed` flag is meant to
		 * track: "every changed line of this file is covered by some claim".
		 * Ticking a range that leaves nothing uncovered auto-ticks the file too
		 * (skipped when a whole-file claim is already active — nothing to add);
		 * unticking one re-checks the remaining claims before untangling the
		 * file flag, since an overlapping block can still leave the file fully
		 * covered (skipped when no whole-file claim is active — nothing to
		 * remove). Either way this only changes the *file* row; the range claim
		 * that was actually ticked/unticked already happened above.
		 */
		const setRangeViewed = (
			sessionId: string,
			path: string,
			blockId: string,
			blockLabel: string,
			ranges: ReadonlyArray<{
				readonly startLine: number;
				readonly endLine: number;
			}>,
			viewed: boolean,
		) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const diffHead = yield* resolveDiffHead(session, repoRoot);

				if (!viewed) {
					yield* reviewStore.unmarkRangeViewed(sessionId, path, blockId);

					const states = yield* reviewStore.listReviewStates(sessionId);
					const activeFileClaim = toActiveFileClaim(
						resolveReviewState(states, path, undefined),
					);
					if (activeFileClaim === null) return;

					// Feeds `reconcilePathAgainstBase` as head content only — never
					// persisted here, so absence maps to empty content per the
					// "missing content at any state is `\"\"`" convention
					// (`@repo/review`'s `reconcile.ts`), the same as every other
					// reconciliation call treats an absent file. A genuine read
					// failure still propagates.
					const contentOption = yield* readCurrentBlobContent(
						repoRoot,
						path,
						diffHead,
					);
					const content = Option.getOrElse(
						contentOption,
						() => new Uint8Array(),
					);
					const reconciliation = yield* reconcilePathAgainstBase(
						sessionId,
						session,
						repoRoot,
						path,
						diffHead,
						activeFileClaim,
						content,
					);
					if (reconciliation !== null && hasUnreviewedRanges(reconciliation)) {
						yield* reviewStore.markFileUnviewed(sessionId, path);
					}
					return;
				}

				const contentOption = yield* readCurrentBlobContent(
					repoRoot,
					path,
					diffHead,
				);
				// `review_range_claims.snapshotHash` is `NOT NULL` (unlike
				// `reviewed_files`', which now distinguishes absence via `NULL` —
				// see `setFileViewed`) — relaxing that needs a full SQLite table
				// rebuild (see `packages/review/AGENTS.md`), not worth it for this
				// case. Absence deliberately maps to empty content here, the same
				// "missing content at any state is `\"\"`" convention
				// `reconcile.ts` documents — a genuine read failure still
				// propagates, this is reached only on real absence.
				const rangeContent = Option.getOrElse(
					contentOption,
					() => new Uint8Array(),
				);
				yield* reviewStore.markRangeViewed(
					sessionId,
					path,
					blockId,
					blockLabel,
					ranges,
					rangeContent,
				);

				const states = yield* reviewStore.listReviewStates(sessionId);
				const activeFileClaim = toActiveFileClaim(
					resolveReviewState(states, path, undefined),
				);
				if (activeFileClaim !== null) return;

				const reconciliation = yield* reconcilePathAgainstBase(
					sessionId,
					session,
					repoRoot,
					path,
					diffHead,
					activeFileClaim,
					rangeContent,
				);
				if (reconciliation !== null && !hasUnreviewedRanges(reconciliation)) {
					// Preserves absence through to `markFileViewed` (unlike
					// `rangeContent` above) so an auto-tick of the whole-file claim
					// gets the same `NULL`-snapshot encoding a direct
					// `setFileViewed` tick would.
					yield* reviewStore.markFileViewed(sessionId, path, contentOption);
				}
			});

		return {
			openSession,
			openPullRequestSession,
			recordRepoPath,
			listSessions,
			closeSession,
			resolveSessionRepoRoot,
			listChangedFiles,
			readFileContents,
			setFileViewed,
			setRangeViewed,
		};
	}),
}) {
	// `provideMerge`, not `provide` — the walkthrough generation loop needs
	// `ReviewStore` directly (to resolve a session's `repoRoot`/`baseRef`
	// without going through `Store`), not just as `Store.make`'s own
	// construction-time dependency. Same gotcha as `FileSystem` below it.
	// `SettingsStore.layer` is the same value `index.ts`'s `MainLayer` merges
	// in at the top level — Effect memoizes layers by reference, so this
	// doesn't open a second connection, it just satisfies `Store.make`'s own
	// construction-time dependency on it (`resolveRepoPath`/`recordRepoPath`).
	static layer = Layer.effect(Store, Store.make).pipe(
		Layer.provideMerge(ReviewStore.layer),
		Layer.provideMerge(SettingsStore.layer),
	);
}

export type {
	GhOutputDecodeError,
	GitCommandError,
	GitHubUnreachable,
	NoDefaultBranch,
	WorktreeRelocationFailed,
};
export { SessionNotFound };
