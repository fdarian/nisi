import { join } from "node:path";
import {
	type FileContentRequest,
	type GhOutputDecodeError,
	type GitCommandError,
	type FileChange as GitFileChange,
	type FileContent as GitFileContent,
	type GitHubTarget,
	type GitHubUnreachable,
	getChangedFiles,
	getFileContents,
	type NoDefaultBranch,
	readFileContentsAtRef,
	resolveCurrentBranch,
	resolveMergeBase,
	resolveRepoRoot,
	resolveReviewTarget,
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
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
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

/**
 * `sessions.open`'s target selector — mirrors `packages/sidecar-api`'s
 * `OpenSessionTarget`. Kept as this module's own type (not imported) the same
 * way `Session` below is, since `http.ts` decodes the wire input before this
 * ever sees it.
 */
export type OpenSessionTarget =
	| { readonly kind: "auto" }
	| { readonly kind: "pr" }
	| { readonly kind: "branch"; readonly baseRef?: string };

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

/** Narrows a whole-file review row down to the shape `readFileContents` actually needs — `null` unless it's a real, snapshotted "viewed" tick. */
const toActiveFileClaim = (
	state: FileReviewState | null,
): { readonly snapshotHash: string; readonly viewedAt: number } | null => {
	if (state === null || !state.viewed || state.snapshotHash === null)
		return null;
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
 *   the caller named its own base, there's nothing to look up. It's still
 *   validated via `resolveMergeBase`, the same resolution `getChangedFiles`/
 *   `getFileContents` would do anyway, just run here so a typo'd ref fails
 *   the request (`InvalidBaseRef`) before a session is ever persisted,
 *   instead of surfacing as an opaque error the first time Files Changed
 *   loads.
 * - `"branch"` with no `baseRef` falls back to the repo's default branch,
 *   still ignoring any PR open on the current branch — not re-validated,
 *   since `resolveReviewTarget`'s own resolution is git-derived by
 *   construction.
 * - `"pr"` requires a PR: `resolveReviewTarget` finding none fails with
 *   `NoPullRequest` rather than silently degrading to a branch diff the
 *   caller didn't ask for.
 * - `"auto"` is today's behavior — PR if one's open, else the default
 *   branch.
 *
 * Head is always the current checkout (`resolveCurrentBranch`, or the PR's
 * own `headRefName` for `"pr"`/`"auto"` when a PR is in play) — nisi doesn't
 * support reviewing an arbitrary head.
 */
const resolveSessionTarget = (repoRoot: string, target: OpenSessionTarget) =>
	Effect.gen(function* () {
		if (target.kind === "branch" && target.baseRef !== undefined) {
			const baseRef = target.baseRef;
			yield* resolveMergeBase(repoRoot, baseRef).pipe(
				Effect.catchTag("GitCommandError", (cause) =>
					Effect.fail(
						new InvalidBaseRef({ repoRoot, baseRef, stderr: cause.stderr }),
					),
				),
			);
			const headRef = yield* resolveCurrentBranch(repoRoot);
			return { baseRef, headRef, pr: null };
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
		const fs = yield* FileSystem;

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
		 * `includeUncommitted`: worktree bytes (`fs.readFile`, one call per path
		 * — cheap enough locally that batching buys nothing) when `true`, HEAD's
		 * tree (`@repo/git`'s `readFileContentsAtRef`, one batched `cat-file
		 * --batch` call over every path) when `false`. Either way this only
		 * ever runs over the paths the caller actually asks for — scoped to
		 * files with active review state by both call sites below, not the
		 * diff's total size. A path missing either way (deleted since review,
		 * or never existed at HEAD) hashes as empty content, the same "diff
		 * against /dev/null" convention `setFileViewed`/`@repo/review`'s
		 * `reconcile` both use — not a swallowed error.
		 */
		const readCurrentHashes = (
			repoRoot: string,
			includeUncommitted: boolean,
			paths: ReadonlyArray<string>,
		): Effect.Effect<
			ReadonlyMap<string, string>,
			GitCommandError,
			FileSystem | ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				if (includeUncommitted) {
					const entries = yield* Effect.forEach(
						paths,
						(path) =>
							fs.readFile(join(repoRoot, path)).pipe(
								Effect.orElseSucceed(() => new Uint8Array()),
								Effect.map((content) => [path, hashContent(content)] as const),
							),
						{ concurrency: "unbounded" },
					);
					return new Map(entries);
				}

				const contents = yield* readFileContentsAtRef(repoRoot, "HEAD", paths);
				const hashes = new Map<string, string>();
				for (const path of paths) {
					hashes.set(path, hashContent(contents.get(path) ?? new Uint8Array()));
				}
				return hashes;
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
		): Effect.Effect<
			ReadonlyArray<FileChange>,
			SessionNotFound | ReviewStoreError | GitCommandError,
			FileSystem | ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const states = yield* reviewStore.listReviewStates(sessionId);

				const claims = new Map<
					string,
					{ readonly snapshotHash: string; readonly viewedAt: number }
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
				);

				return files.map((file) => {
					const claim = claims.get(file.path);
					if (claim === undefined) return { ...file, review: null };
					const currentHash =
						currentHashes.get(file.path) ?? hashContent(new Uint8Array());
					const review: FileReview = {
						viewed: true,
						reviewedHash: claim.snapshotHash,
						changedSinceReview: currentHash !== claim.snapshotHash,
					};
					return { ...file, review };
				});
			});

		const listChangedFiles = (sessionId: string, includeUncommitted: boolean) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const files = yield* getChangedFiles(
					session.repoRoot,
					session.baseRef,
					{
						includeUncommitted,
					},
				);
				return yield* attachReviewState(
					sessionId,
					session.repoRoot,
					includeUncommitted,
					files,
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
				readonly snapshotHash: string;
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
								snapshotContent: new TextDecoder().decode(
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
				readonly snapshotHash: string;
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
		 * `listChangedFiles`, so `content.newContent` — and therefore
		 * `reconcile`'s `changedSinceReview`/`ranges` below — already compares
		 * against HEAD, not the worktree, in committed-only mode: no extra logic
		 * needed here, it falls out of threading the flag into the one content
		 * fetch this function makes. The `content.truncated` fallback just below
		 * threads the same flag through `readCurrentHashes` instead, since a
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
				const contentByPath = yield* getFileContents(
					session.repoRoot,
					session.baseRef,
					requests satisfies ReadonlyArray<FileContentRequest>,
					{ includeUncommitted },
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
									session.repoRoot,
									includeUncommitted,
									[request.path],
								);
								const currentHash =
									currentHashes.get(request.path) ??
									hashContent(new Uint8Array());
								const changedSinceReview =
									currentHash !== activeFileClaim.snapshotHash;
								return {
									path: request.path,
									content: {
										...content,
										review: { changedSinceReview, ranges: [] },
									},
								};
							}

							const review = yield* reconcilePathClaims(
								sessionId,
								session.repoRoot,
								request.path,
								request.oldPath,
								activeFileClaim,
								content.oldContent ?? "",
								content.newContent ?? "",
							);

							return { path: request.path, content: { ...content, review } };
						}),
					{ concurrency: "unbounded" },
				);
			});

		/**
		 * Un-ticking Reviewed just clears the snapshot. Ticking it reads the
		 * file's *current worktree* content directly — this is a plain read, not
		 * `@repo/git`'s size-gated `getFileContents`, since a review snapshot's
		 * whole point is fidelity. A missing file (ticking Reviewed on a
		 * deletion) snapshots as empty content, matching how git itself treats
		 * "diff against /dev/null" — not a swallowed error.
		 */
		const setFileViewed = (sessionId: string, path: string, viewed: boolean) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				if (!viewed) {
					yield* reviewStore.markFileUnviewed(sessionId, path);
					return;
				}
				const content = yield* fs
					.readFile(join(session.repoRoot, path))
					.pipe(Effect.orElseSucceed(() => new Uint8Array()));
				yield* reviewStore.markFileViewed(sessionId, path, content);
			});

		/**
		 * `reconcilePathClaims` fed worktree content directly instead of
		 * `getFileContents`' batched patch: fetches `path`'s content at
		 * `merge-base(baseRef, HEAD)` — the same old-side commit
		 * `getFileContents` diffs against (see its doc comment: "Old-side
		 * content is always at `mergeBase`"), never `baseRef` directly, so this
		 * reconciles against the identical base content `readFileContents`
		 * already showed the user, not a different one that happens to also be
		 * called "base" — then reconciles it against `headContentBytes` (the
		 * worktree bytes `setRangeViewed` already read or wrote) plus
		 * `activeFileClaim`/every other currently active range claim. Used by
		 * `setRangeViewed` to re-derive, right after a mark/unmark, whether the
		 * file's whole-file `viewed` flag should follow.
		 */
		const reconcilePathAgainstBase = (
			sessionId: string,
			session: ReviewSession,
			path: string,
			activeFileClaim: {
				readonly snapshotHash: string;
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
					session.repoRoot,
					session.baseRef,
				);
				const baseContentBytes = yield* readFileContentsAtRef(
					session.repoRoot,
					mergeBase,
					[path],
				);
				return yield* reconcilePathClaims(
					sessionId,
					session.repoRoot,
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

				if (!viewed) {
					yield* reviewStore.unmarkRangeViewed(sessionId, path, blockId);

					const states = yield* reviewStore.listReviewStates(sessionId);
					const activeFileClaim = toActiveFileClaim(
						resolveReviewState(states, path, undefined),
					);
					if (activeFileClaim === null) return;

					const content = yield* fs
						.readFile(join(session.repoRoot, path))
						.pipe(Effect.orElseSucceed(() => new Uint8Array()));
					const reconciliation = yield* reconcilePathAgainstBase(
						sessionId,
						session,
						path,
						activeFileClaim,
						content,
					);
					if (reconciliation !== null && hasUnreviewedRanges(reconciliation)) {
						yield* reviewStore.markFileUnviewed(sessionId, path);
					}
					return;
				}

				const content = yield* fs
					.readFile(join(session.repoRoot, path))
					.pipe(Effect.orElseSucceed(() => new Uint8Array()));
				yield* reviewStore.markRangeViewed(
					sessionId,
					path,
					blockId,
					blockLabel,
					ranges,
					content,
				);

				const states = yield* reviewStore.listReviewStates(sessionId);
				const activeFileClaim = toActiveFileClaim(
					resolveReviewState(states, path, undefined),
				);
				if (activeFileClaim !== null) return;

				const reconciliation = yield* reconcilePathAgainstBase(
					sessionId,
					session,
					path,
					activeFileClaim,
					content,
				);
				if (reconciliation !== null && !hasUnreviewedRanges(reconciliation)) {
					yield* reviewStore.markFileViewed(sessionId, path, content);
				}
			});

		return {
			openSession,
			listSessions,
			closeSession,
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
	static layer = Layer.effect(Store, Store.make).pipe(
		Layer.provideMerge(ReviewStore.layer),
	);
}

export type {
	GhOutputDecodeError,
	GitCommandError,
	GitHubUnreachable,
	NoDefaultBranch,
};
export { SessionNotFound };
