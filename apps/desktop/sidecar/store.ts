import { join } from "node:path";
import {
	diffContentsPatch,
	type FileContentRequest,
	fetchBaseRef,
	type GhOutputDecodeError,
	type GitCommandError,
	type FileChange as GitFileChange,
	type FileContent as GitFileContent,
	GitHub,
	type GitHubTarget,
	type GitHubUnreachable,
	getChangedFiles,
	getFileContents,
	inferRepoPath,
	type NoDefaultBranch,
	type NoOriginRemote,
	openPullRequestWorktreeResult,
	PullRequestNotFound,
	type PullRequestRef,
	type PullRequestRefNotFound,
	type RepoPathNotAGitRepo,
	type RepoPathNotFound,
	type RepoPathVerificationError,
	readFileContentsAtRef,
	readLocalBase,
	readWorktreeBlobContent,
	resolveCurrentBranch,
	resolveDiffBaseRef,
	resolveMainCloneRoot,
	resolveMergeBase,
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
import { Context, Effect, Layer, Option, Schema, Scope } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { makeBaseRefresh } from "./base-refresh.ts";
import {
	type DiffHead,
	type InvalidHeadRef,
	resolveDiffHead,
	validateHeadRef,
} from "./diff-head.ts";
import { makeDiffPreparation } from "./diff-preparation.ts";
import { emit } from "./events.ts";
import { PrIndex } from "./pr-index.ts";
import { resolveOpenRepoRoot } from "./repo-root.ts";

/** `sessions.open`'s `cwd` doesn't resolve to a git working tree. */
export class InvalidCwd extends Schema.TaggedError<InvalidCwd>()("InvalidCwd", {
	cwd: Schema.String,
}) {}

/** `sessions.open`'s `target: { kind: "pr" }` asked for a PR, but `resolveReviewTarget` found none open for the current branch. */
export class NoPullRequest extends Schema.TaggedError<NoPullRequest>()(
	"NoPullRequest",
	{
		repoRoot: Schema.String,
	},
) {}

/** `sessions.open`'s `target: { kind: "branch", baseRef }` named a ref `git` couldn't resolve — typically a typo. `stderr` is git's own explanation, carried through so the caller sees which ref was bad instead of a generic "invalid base". */
export class InvalidBaseRef extends Schema.TaggedError<InvalidBaseRef>()(
	"InvalidBaseRef",
	{
		repoRoot: Schema.String,
		baseRef: Schema.String,
		stderr: Schema.String,
	},
) {}

/** `file.get` asked for a path that doesn't exist in the resolved universe (the worktree, or `diffHead.headRef`'s committed tree — see `readFileViewerContent`) — distinct from a git failure, so the frontend can render "this file doesn't exist" instead of a generic error. */
export class FileViewerPathNotFound extends Schema.TaggedError<FileViewerPathNotFound>()(
	"FileViewerPathNotFound",
	{ path: Schema.String },
) {}

/** `file.get`'s content exceeded `FILE_VIEWER_MAX_BYTES` — a real, renderable outcome (nothing bounds how large an arbitrary repo path can be) rather than a failure the caller has no way to distinguish from a genuine error. */
export class FileViewerContentTooLarge extends Schema.TaggedError<FileViewerContentTooLarge>()(
	"FileViewerContentTooLarge",
	{ path: Schema.String, size: Schema.Number },
) {}

/**
 * `readFileViewerContent`'s hard cap — mirrors `@repo/git`'s own
 * `LOAD_ON_DEMAND_LIMIT` (`packages/git/src/diff.ts`, not exported and not
 * reused directly: this viewer doesn't go through `getFileContents` at
 * all). Unlike the diff pane's own size gate, there's no "Load anyway"
 * override for this procedure — see `packages/sidecar-api`'s `file.ts` doc
 * comment for why the contract carries no `force` field.
 */
const FILE_VIEWER_MAX_BYTES = 2 * 1024 * 1024;

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

export type OpenSessionOutcome =
	| { readonly kind: "opened"; readonly session: Session }
	| {
			readonly kind: "retargeted" | "existing";
			readonly session: Session;
			readonly sourceSessionId: string;
	  };

/** `pullRequests.open`'s input — the palette only ever knows `owner/repo#number`, never a local path; see `openPullRequestSession`'s doc for how the rest gets resolved. */
export type OpenPullRequestInput = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};

/** The wire open result plus the internal session transition needed to emit events. */
export type OpenPullRequestOutcome =
	| { readonly status: "opened"; readonly outcome: OpenSessionOutcome }
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
 * still holds; see `diff-head.ts`'s `resolveDiffHead` and this file's
 * `resolveSessionDiffHead`.
 */
const resolveSessionTarget = (repoRoot: string, target: OpenSessionTarget) =>
	Effect.gen(function* () {
		if (target.kind === "branch" && target.baseRef !== undefined) {
			const baseRef = target.baseRef;
			const explicitHeadRef = target.headRef;

			if (explicitHeadRef !== undefined) {
				yield* validateHeadRef(repoRoot, explicitHeadRef);
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
		const prIndex = yield* PrIndex;
		const scope = yield* Scope.Scope;
		const preparation = yield* makeDiffPreparation();
		const baseIdentity = (repoRoot: string, baseRef: string) =>
			Effect.gen(function* () {
				const identity = yield* Effect.all(
					[resolveMainCloneRoot(repoRoot), readLocalBase(repoRoot, baseRef)],
					{ concurrency: "unbounded" },
				);
				return {
					key: `${identity[0]}\n${identity[1].baseRef}`,
					commit: identity[1].commit,
				};
			});
		const baseFetchState = yield* makeBaseRefresh({
			identity: baseIdentity,
			fetch: fetchBaseRef,
			now: Date.now,
			moved: (key) =>
				Effect.gen(function* () {
					const sessions = yield* reviewStore.listOpenSessions();
					for (const session of sessions) {
						const identity = yield* baseIdentity(
							session.repoRoot,
							session.baseRef,
						);
						if (identity.key === key)
							emit({ type: "session-files-changed", sessionId: session.id });
					}
				}),
		});
		const refreshBase = baseFetchState.refresh;
		const prepareBase = baseFetchState.prepare;

		const retargetSessionToPr = (
			sessionId: string,
			pr: SessionPullRequest,
			baseRef: string,
			headRef: string,
		) =>
			Effect.gen(function* () {
				// A same-key PR session is a collision: close the source row here,
				// while the sidecar-wide teardown stays in `http.ts` alongside
				// `sessions.close`'s cleanup.
				const outcome = yield* reviewStore.retargetToPullRequest(
					sessionId,
					pr,
					baseRef,
					headRef,
				);
				if (outcome.kind === "existing") {
					yield* reviewStore.closeSession(sessionId);
				}
				return {
					kind: outcome.kind,
					session: toWireSession(outcome.session),
					sourceSessionId: sessionId,
				} as const;
			});

		const retargetMatchingBranchSession = (
			repoRoot: string,
			sessions: ReadonlyArray<ReviewSession>,
			pr: PullRequestRef,
		) =>
			Effect.gen(function* () {
				if (pr.isCrossRepository) return null;
				const mainCloneRoot = yield* resolveMainCloneRoot(repoRoot);
				const candidates = yield* Effect.filter(
					sessions.filter(
						(session) => session.pr === null && session.headRef === pr.headRef,
					),
					(session) =>
						Effect.gen(function* () {
							const root = yield* resolveMainCloneRoot(session.repoRoot);
							if (root !== mainCloneRoot) return false;
							return (
								(yield* resolveCurrentBranch(session.repoRoot)) === pr.headRef
							);
						}).pipe(
							Effect.catchTags({
								RepoPathNotFound: () => Effect.succeed(false),
								RepoPathNotAGitRepo: () => Effect.succeed(false),
								GitCommandError: () => Effect.succeed(false),
							}),
						),
				);
				const source =
					candidates.find((session) => session.baseRef === pr.baseRef) ??
					candidates.at(0);
				if (source === undefined) return null;
				const resolved = yield* resolveSessionTarget(source.repoRoot, {
					kind: "specificPullRequest",
					number: pr.number,
				});
				if (resolved.pr === null) return null;
				yield* prepareBase(source.repoRoot, resolved.baseRef);
				return yield* retargetSessionToPr(
					source.id,
					resolved.pr,
					resolved.baseRef,
					resolved.headRef,
				).pipe(
					Effect.tap(() =>
						baseFetchState.background(source.repoRoot, resolved.baseRef),
					),
					Effect.catchTag("SessionNotFound", () => Effect.succeed(null)),
				);
			});

		const persistResolved = (
			repoRoot: string,
			target: OpenSessionTarget,
			resolved: {
				baseRef: string;
				headRef: string;
				pr: SessionPullRequest | null;
			},
		) =>
			Effect.gen(function* () {
				yield* prepareBase(repoRoot, resolved.baseRef).pipe(
					Effect.withSpan("session.base-ref.refresh"),
				);
				const openFreshSession = reviewStore
					.openSession({
						repoRoot,
						baseRef: resolved.baseRef,
						headRef: resolved.headRef,
						pr: resolved.pr,
					})
					.pipe(
						Effect.withSpan("session.persist"),
						Effect.tap(() =>
							baseFetchState.background(repoRoot, resolved.baseRef),
						),
						Effect.map((session) => ({
							kind: "opened" as const,
							session: toWireSession(session),
						})),
					);
				if (
					resolved.pr !== null &&
					(target.kind === "auto" || target.kind === "pr")
				) {
					const branchSessions = yield* reviewStore.listOpenBranchSessions(
						repoRoot,
						resolved.headRef,
					);
					const source =
						branchSessions.find(
							(session) => session.baseRef === resolved.baseRef,
						) ?? branchSessions.at(0);
					if (source !== undefined) {
						return yield* retargetSessionToPr(
							source.id,
							resolved.pr,
							resolved.baseRef,
							resolved.headRef,
						).pipe(
							Effect.tap(() =>
								baseFetchState.background(repoRoot, resolved.baseRef),
							),
							Effect.catchTag("SessionNotFound", () => openFreshSession),
						);
					}
				}
				return yield* openFreshSession;
			});

		const latestOpens = new Map<string, object>();
		const validations = new Map<
			string,
			{ repoRoot: string; target: OpenSessionTarget; generation: object }
		>();
		const openSession = (
			cwd: string,
			target: OpenSessionTarget = { kind: "auto" },
			providedRepoRoot?: string,
		) =>
			Effect.gen(function* () {
				const repoRoot = yield* resolveOpenRepoRoot(cwd, providedRepoRoot).pipe(
					Effect.catchTag("NotAGitRepository", () => new InvalidCwd({ cwd })),
					Effect.withSpan("session.repo-root.resolve"),
				);
				const generation = {};
				latestOpens.set(repoRoot, generation);
				const cached =
					target.kind === "auto" || target.kind === "pr"
						? yield* prIndex.lookup(repoRoot)
						: undefined;
				const resolved =
					cached === undefined
						? yield* resolveSessionTarget(repoRoot, target).pipe(
								Effect.withSpan("session.target.resolve", {
									attributes: { repoRoot, target: target.kind },
								}),
							)
						: {
								baseRef: cached.pr.baseRef,
								headRef: cached.pr.headRef,
								pr: {
									number: cached.pr.number,
									title: cached.pr.title,
									owner: cached.repository.owner,
									repo: cached.repository.repo,
								},
							};
				const outcome = yield* persistResolved(repoRoot, target, resolved);
				if (cached !== undefined)
					validations.set(outcome.session.id, { repoRoot, target, generation });
				if (resolved.pr !== null) {
					const pr = resolved.pr;
					yield* Effect.gen(function* () {
						const known = yield* settingsStore.getRepoPath(pr.owner, pr.repo);
						if (known !== null) return;
						const root = yield* resolveMainCloneRoot(repoRoot);
						yield* verifyRepoPathMatchesOrigin(root, pr.owner, pr.repo);
						yield* settingsStore.setRepoPath(pr.owner, pr.repo, root);
						yield* prIndex.refresh(root, pr.owner, pr.repo);
					}).pipe(
						Effect.catchCause((cause) =>
							Effect.logWarning("could not learn PR index repository path", {
								cause,
							}),
						),
						Effect.forkIn(scope),
					);
				}
				return outcome;
			});
		const revalidateSession = (session: Session) =>
			Effect.gen(function* () {
				const validation = validations.get(session.id);
				if (validation === undefined) return undefined;
				validations.delete(session.id);
				const resolved = yield* resolveSessionTarget(validation.repoRoot, {
					kind: "auto",
				});
				if (latestOpens.get(validation.repoRoot) !== validation.generation)
					return undefined;
				const stillOpen = (yield* reviewStore.listOpenSessions()).some(
					(entry) => entry.id === session.id,
				);
				if (!stillOpen) return undefined;
				const same =
					session.target.baseRef === resolved.baseRef &&
					session.target.headRef === resolved.headRef &&
					(session.target.kind === "pr"
						? resolved.pr !== null &&
							session.target.number === resolved.pr.number &&
							session.target.title === resolved.pr.title &&
							session.target.owner === resolved.pr.owner &&
							session.target.repo === resolved.pr.repo
						: resolved.pr === null);
				if (same) return undefined;
				const corrected = yield* persistResolved(
					validation.repoRoot,
					validation.target,
					resolved,
				);
				if (corrected.session.id === session.id)
					return {
						kind: "retargeted" as const,
						session: corrected.session,
						sourceSessionId: session.id,
					};
				// Never retarget a PR row to a different PR: upsert the correct key and close only the provisional tab.
				yield* reviewStore.closeSession(session.id);
				return {
					kind: "existing" as const,
					session: corrected.session,
					sourceSessionId: session.id,
				};
			}).pipe(Effect.withSpan("session.pr-index.revalidate", { root: true }));

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
		 * The command palette's "Switch to PR" action — transforms `sessionId`'s
		 * row from a `"branch"` target onto the PR open for its current branch,
		 * in place (`@repo/review`'s `retargetToPullRequest`, not
		 * `openSession` — the row already exists). `resolveSessionTarget`
		 * resolves the target the same way `openSession`'s own `"pr"` selector
		 * does, so `NoPullRequest` behaves identically; `resolved.pr` is only
		 * ever `null` from that function's `"branch"` variant, unreachable here.
		 *
		 * Returns the retarget outcome alongside the wire session, not just the
		 * session — `http.ts`'s handler needs `kind` to know whether a row
		 * genuinely closed (see the collision branch below) so it can run the
		 * matching sidecar-wide teardown and emit the right event, and
		 * shouldn't have to re-derive that by comparing ids.
		 */
		const switchToPr = (sessionId: string) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const resolved = yield* resolveSessionTarget(repoRoot, {
					kind: "pr",
				});
				if (resolved.pr === null) {
					return yield* Effect.die(
						new Error(
							"resolveSessionTarget({ kind: 'pr' }) resolved with no pr",
						),
					);
				}

				yield* refreshBase(repoRoot, resolved.baseRef);
				return yield* retargetSessionToPr(
					sessionId,
					resolved.pr,
					resolved.baseRef,
					resolved.headRef,
				);
			});

		/** The palette and deep-link open path: reuse a PR by identity across roots,
		 * or retarget a same-repository branch checkout with its review state intact.
		 * Only otherwise create/reuse a nisi PR worktree and open a session there.
		 * The transition outcome stays internal so HTTP can emit the matching events.
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
			| RepoPathNotFound
			| RepoPathNotAGitRepo
			| SettingsStoreError,
			ChildProcessSpawner.ChildProcessSpawner | FileSystem | GitHub
		> =>
			Effect.gen(function* () {
				const repoRoot = yield* resolveRepoPath(input.owner, input.repo).pipe(
					Effect.withSpan("pull-request.mapping.lookup"),
				);
				if (repoRoot === null) {
					return {
						status: "needs-repo-path" as const,
						owner: input.owner,
						repo: input.repo,
					};
				}

				const sessions = yield* reviewStore
					.listOpenSessions()
					.pipe(Effect.withSpan("pull-request.sessions.lookup"));
				const existing = sessions.find(
					(session) =>
						session.pr !== null &&
						session.pr.number === input.number &&
						session.pr.owner.toLowerCase() === input.owner.toLowerCase() &&
						session.pr.repo.toLowerCase() === input.repo.toLowerCase(),
				);
				if (existing !== undefined) {
					yield* Effect.annotateCurrentSpan({
						worktree: "reused",
						worktreePath: existing.repoRoot,
					});
					return {
						status: "opened" as const,
						outcome: {
							kind: "opened" as const,
							session: toWireSession(existing),
						},
					};
				}

				const github = yield* GitHub;
				const pr = yield* github.pullRequest(repoRoot, input.number);
				if (pr === null) {
					return yield* new PullRequestNotFound({
						repoRoot,
						number: input.number,
						reason: "GitHub returned no pull request for the requested number",
					});
				}
				const reused = yield* retargetMatchingBranchSession(
					repoRoot,
					sessions,
					pr,
				).pipe(
					Effect.withSpan("pull-request.session.retarget"),
					Effect.catchTags({
						RepoPathNotFound: () => Effect.succeed(null),
						RepoPathNotAGitRepo: () => Effect.succeed(null),
					}),
				);
				if (reused !== null) {
					yield* Effect.annotateCurrentSpan({
						worktree: "retargeted",
						worktreePath: reused.session.repoRoot,
					});
					return { status: "opened" as const, outcome: reused };
				}

				const worktree = yield* openPullRequestWorktreeResult({
					repoRoot,
					number: input.number,
					headRef: pr.headRef,
				}).pipe(Effect.withSpan("pull-request.worktree.open"));
				yield* Effect.annotateCurrentSpan({
					worktree: worktree.worktree,
					worktreePath: worktree.path,
					...(worktree.localHeadRefPresent === undefined
						? {}
						: { localHeadRefPresent: worktree.localHeadRefPresent }),
				});
				const worktreePath = worktree.path;
				const outcome = yield* openSession(worktreePath, {
					kind: "specificPullRequest",
					number: input.number,
				}).pipe(Effect.withSpan("pull-request.session.open"));
				return { status: "opened" as const, outcome };
			}).pipe(Effect.withSpan("pull-requests.open"));

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

		const resolveScheduledMergeRepoRoot = (input: {
			repoRoot: string;
			owner: string;
			repo: string;
			number: number;
		}) =>
			Effect.gen(function* () {
				const fs = yield* FileSystem;
				if (yield* fs.exists(input.repoRoot)) return input.repoRoot;
				const sessions = yield* reviewStore.listOpenSessions();
				const session = sessions.find(
					(candidate) =>
						candidate.pr?.owner === input.owner &&
						candidate.pr.repo === input.repo &&
						candidate.pr.number === input.number,
				);
				if (session === undefined) return null;
				return yield* resolveLiveRepoRoot(session).pipe(
					Effect.catchTag("WorktreeRelocationFailed", () =>
						Effect.succeed(null),
					),
				);
			});

		const listSessions = () =>
			reviewStore.listOpenSessions().pipe(
				Effect.tap((sessions) =>
					Effect.forEach(
						sessions,
						(session) => {
							return prepareBase(session.repoRoot, session.baseRef, true).pipe(
								Effect.andThen(
									baseFetchState.background(session.repoRoot, session.baseRef),
								),
								Effect.catchTag("GitCommandError", (error) =>
									Effect.logWarning("Could not refresh restored session base", {
										error,
									}),
								),
							);
						},
						{ concurrency: 4 },
					),
				),
				Effect.map((sessions) => sessions.map(toWireSession)),
			);

		const closeSession = (sessionId: string) =>
			reviewStore.closeSession(sessionId);

		/**
		 * `paths`' current content, all read from the same universe the diff
		 * itself is displayed from — worktree bytes (`@repo/git`'s
		 * `readWorktreeBlobContent`, one call per path — cheap enough locally
		 * that batching buys nothing) when `includeUncommitted` AND
		 * `diffHead.worktreeEligible` both hold, otherwise `diffHead.headRef`'s
		 * own committed tree (`@repo/git`'s `readFileContentsAtRef`, one
		 * batched `cat-file --batch` call over every path). This is the one
		 * gate every caller needing "what does this path look like right now"
		 * goes through — `setFileViewed`/`setRangeViewed`'s snapshot writes and
		 * `attachReviewState`/`readFileContents`'s changed-since-review reads
		 * alike — so a ticked file's snapshot and its later comparison can
		 * never disagree about which universe "current" means. They used to:
		 * the write side gated on `diffHead.worktreeEligible` alone, ignoring
		 * `includeUncommitted` entirely, while every read side additionally
		 * required it — with `includeUncommitted` off, ticking Reviewed
		 * snapshotted the worktree while the very next read compared against
		 * HEAD's tree, so a hash mismatch (and the "Modified after review"
		 * badge) was guaranteed even with nothing actually touched. A path
		 * missing from that universe (deleted, or never existed) is simply
		 * absent from the returned map — not a swallowed error, and not stood
		 * in for with a placeholder value; callers interpret an absent entry
		 * themselves (see `hasChangedSinceReview`). A genuine read failure
		 * (permissions, a directory in the file's place, ...) propagates as
		 * `WorktreeReadFailed`/`GitCommandError` instead of collapsing into
		 * either case.
		 */
		const readCurrentContent = (
			repoRoot: string,
			diffHead: DiffHead,
			includeUncommitted: boolean,
			paths: ReadonlyArray<string>,
		): Effect.Effect<
			ReadonlyMap<string, Uint8Array>,
			GitCommandError | WorktreeReadFailed,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				if (includeUncommitted && diffHead.worktreeEligible) {
					const entries = yield* Effect.forEach(
						paths,
						(path) =>
							readWorktreeBlobContent(join(repoRoot, path)).pipe(
								Effect.map((content) => [path, content] as const),
							),
						{ concurrency: "unbounded" },
					);
					const contents = new Map<string, Uint8Array>();
					for (const [path, content] of entries) {
						if (Option.isSome(content)) {
							contents.set(path, content.value);
						}
					}
					return contents;
				}

				return yield* readFileContentsAtRef(
					repoRoot,
					diffHead.headRef ?? "HEAD",
					paths,
				);
			});

		/**
		 * `readCurrentContent`, hashed the same way a review snapshot is hashed
		 * (`@repo/review`'s `hashContent`, SHA-256 of raw bytes — not a git
		 * object id, which wouldn't compare against a stored `snapshotHash` at
		 * all), so a caller can tell a ticked file's snapshot apart from what's
		 * actually there now without holding the full content in memory.
		 * Scoped to whatever `paths` the caller actually asks for — files with
		 * active review state, not the diff's total size.
		 */
		const readCurrentHashes = (
			repoRoot: string,
			diffHead: DiffHead,
			includeUncommitted: boolean,
			paths: ReadonlyArray<string>,
		): Effect.Effect<
			ReadonlyMap<string, string>,
			GitCommandError | WorktreeReadFailed,
			ChildProcessSpawner.ChildProcessSpawner
		> =>
			Effect.gen(function* () {
				const contents = yield* readCurrentContent(
					repoRoot,
					diffHead,
					includeUncommitted,
					paths,
				);
				return new Map(
					[...contents].map(
						([path, bytes]) => [path, hashContent(bytes)] as const,
					),
				);
			});

		/**
		 * Whether a reviewed snapshot differs from what's current now, honoring
		 * `@repo/review`'s `snapshotHash: null` convention ("reviewed while
		 * absent" — see `packages/review/src/store.ts`) symmetrically instead
		 * of standing in a placeholder hash for "absent": `null` snapshot vs.
		 * absent current is unchanged (still not there), `null` vs. present is
		 * changed (it showed up), a real snapshot vs. absent current is changed
		 * (it's gone), and a real snapshot vs. present current is a plain hash
		 * compare. A placeholder like `hashContent(new Uint8Array())` — a real
		 * hash, of a real empty file — is never the right stand-in for
		 * "absent": it collides with an actual empty-file review and, worse,
		 * can never equal a non-empty snapshot, so a reviewed-then-deleted file
		 * always reported "changed" even with nothing to compare against.
		 */
		const hasChangedSinceReview = (
			snapshotHash: string | null,
			currentHash: string | undefined,
		): boolean =>
			snapshotHash === null
				? currentHash !== undefined
				: currentHash !== snapshotHash;

		/**
		 * Attaches each file's review state, looked up by its current path with
		 * a fallback to `oldPath` for a rename (a rename's `reviewed_files` row
		 * still lives under the pre-rename path — see `resolveReviewState`).
		 * `changedSinceReview` costs one `readCurrentHashes` batch over only the
		 * files that actually have review state — bounded by how many files the
		 * user has ticked, not by the diff's total size, unlike the live-update
		 * poller's mtime/size-first discipline (which has to scan every changed
		 * file on every tick regardless of review state). Takes `diffHead` and
		 * the raw `includeUncommitted` setting rather than an already-gated
		 * flag — `readCurrentHashes` derives the effective gate itself, so this
		 * can never disagree with whatever `setFileViewed`/`setRangeViewed`
		 * used to write the snapshot being compared against.
		 */
		const attachReviewState = (
			sessionId: string,
			repoRoot: string,
			diffHead: DiffHead,
			includeUncommitted: boolean,
			files: ReadonlyArray<GitFileChange>,
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
					diffHead,
					includeUncommitted,
					[...claims.keys()],
				);

				return files.map((file) => {
					const claim = claims.get(file.path);
					if (claim === undefined) return { ...file, review: null };
					const review: FileReview = {
						viewed: true,
						reviewedHash: claim.snapshotHash,
						changedSinceReview: hasChangedSinceReview(
							claim.snapshotHash,
							currentHashes.get(file.path),
						),
					};
					return { ...file, review };
				});
			});

		/**
		 * `session`'s {@link DiffHead} — see `diff-head.ts`'s `resolveDiffHead`
		 * for the decision itself; this just adapts a `ReviewSession` to that
		 * function's plain `(repoRoot, headRef, hasPullRequest)` signature, so
		 * every call site below reads the same way.
		 */
		const resolveSessionDiffHead = (session: ReviewSession, repoRoot: string) =>
			resolveDiffHead(repoRoot, session.headRef, session.pr !== null);

		const refreshSessionBase = (sessionId: string) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				return yield* refreshBase(repoRoot, session.baseRef);
			});

		const readBaseMayBeStale = (sessionId: string) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const preparedKey = baseFetchState.key(repoRoot, session.baseRef);
				if (preparedKey !== undefined) return baseFetchState.stale(preparedKey);
				const ref = yield* resolveDiffBaseRef(repoRoot, session.baseRef);
				if (!ref.startsWith("refs/remotes/")) return false;
				const root = yield* resolveMainCloneRoot(repoRoot);
				return baseFetchState.stale(`${root}\n${ref}`);
			});

		const listChangedFiles = (sessionId: string, includeUncommitted: boolean) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const diffHead = yield* resolveSessionDiffHead(session, repoRoot);
				const effectiveIncludeUncommitted =
					includeUncommitted && diffHead.worktreeEligible;
				const files = yield* getChangedFiles(repoRoot, session.baseRef, {
					prepared: yield* preparation.read(repoRoot, session.baseRef, {
						includeUncommitted: effectiveIncludeUncommitted,
						headRef: diffHead.headRef,
					}),
					includeUncommitted: effectiveIncludeUncommitted,
					headRef: diffHead.headRef,
				});
				return yield* attachReviewState(
					sessionId,
					repoRoot,
					diffHead,
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
		 * fallback just below threads `diffHead` and the raw `includeUncommitted`
		 * flag through `readCurrentHashes` instead (which derives the same
		 * effective gate internally), since a size-gated file has no
		 * `content.newContent` to reuse.
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
				const diffHead = yield* resolveSessionDiffHead(session, repoRoot);
				const effectiveIncludeUncommitted =
					includeUncommitted && diffHead.worktreeEligible;
				const contentByPath = yield* getFileContents(
					repoRoot,
					session.baseRef,
					requests satisfies ReadonlyArray<FileContentRequest>,
					{
						prepared: yield* preparation.read(repoRoot, session.baseRef, {
							includeUncommitted: effectiveIncludeUncommitted,
							headRef: diffHead.headRef,
						}),
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
									diffHead,
									includeUncommitted,
									[request.path],
								);
								// Same comparison as `attachReviewState` — see
								// `hasChangedSinceReview`.
								const changedSinceReview = hasChangedSinceReview(
									activeFileClaim.snapshotHash,
									currentHashes.get(request.path),
								);
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
		 * One arbitrary path's whole-file content for a file-viewer tab
		 * (`packages/sidecar-api`'s `file.get`) — deliberately not
		 * `readFileContents`/`@repo/git`'s `getFileContents` above: those are
		 * diff-scoped (patch + old/new content pairs for paths the `base →
		 * head` diff actually touches), while a viewer tab can be opened for
		 * any path in the repo — a walkthrough reference into a file outside
		 * the diff, or "View full file" from Files Changed. Reuses
		 * `readCurrentContent` instead, the same "what does this path look
		 * like right now" gate `setFileViewed`'s snapshot write uses:
		 * worktree bytes when `includeUncommitted` (read fresh from
		 * `SettingsStore`, same reasoning as `setFileViewed` — this call
		 * carries no per-request flag of its own) and the session is
		 * worktree-eligible, else `diffHead.headRef`'s own committed tree.
		 *
		 * A path absent from that universe (deleted, never existed, or a
		 * typo'd walkthrough reference) fails `FileViewerPathNotFound` rather
		 * than silently reporting empty content — `readCurrentContent` itself
		 * treats absence as a value (the map simply has no entry), so this is
		 * the one place that turns it into a failure for a caller that has
		 * exactly one path and nothing sensible to render for "nothing here."
		 * Content past `FILE_VIEWER_MAX_BYTES` fails `FileViewerContentTooLarge`
		 * instead of being read and discarded — unlike `getFileContents`'
		 * size gate, there's no worktree-side `stat()` to check first here
		 * (`readCurrentContent` has no such option), so the cap is enforced
		 * after the read; still cheap; nothing here streams to disk first.
		 */
		const readFileViewerContent = (sessionId: string, path: string) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const repoRoot = yield* resolveLiveRepoRoot(session);
				const diffHead = yield* resolveSessionDiffHead(session, repoRoot);
				const settings = yield* settingsStore.get();
				const currentContent = yield* readCurrentContent(
					repoRoot,
					diffHead,
					settings.includeUncommitted,
					[path],
				);
				const bytes = currentContent.get(path);
				if (bytes === undefined) {
					return yield* Effect.fail(new FileViewerPathNotFound({ path }));
				}
				if (bytes.byteLength > FILE_VIEWER_MAX_BYTES) {
					return yield* Effect.fail(
						new FileViewerContentTooLarge({ path, size: bytes.byteLength }),
					);
				}
				return { content: new TextDecoder().decode(bytes) };
			});

		/**
		 * Un-ticking Reviewed just clears the snapshot. Ticking it reads the
		 * file's *current* content directly via `readCurrentContent` — a plain
		 * read, not `@repo/git`'s size-gated `getFileContents`, since a review
		 * snapshot's whole point is fidelity. "Current" follows the exact same
		 * gate `attachReviewState`'s later comparison uses:
		 * `resolveSessionDiffHead` plus this session's own `includeUncommitted`
		 * setting, read fresh from `SettingsStore` since this call carries no
		 * per-request flag of its own — so the snapshot is captured from
		 * whichever universe the next read will compare it against, never the
		 * live worktree while `includeUncommitted` is off or while the
		 * worktree belongs to a different branch entirely. A missing file
		 * (ticking Reviewed on a deletion, or a path that never existed —
		 * either on disk or in `headRef`'s tree) persists as a `NULL` snapshot
		 * hash on a viewed row (`@repo/review`'s `markFileViewed`) rather than
		 * a `sha256("")` blob — the two are distinct claims: `NULL` means
		 * "reviewed while absent" (stays reviewed as long as it's still
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
				const diffHead = yield* resolveSessionDiffHead(session, repoRoot);
				const settings = yield* settingsStore.get();
				const currentContent = yield* readCurrentContent(
					repoRoot,
					diffHead,
					settings.includeUncommitted,
					[path],
				);
				yield* reviewStore.markFileViewed(
					sessionId,
					path,
					Option.fromNullishOr(currentContent.get(path)),
				);
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
		 * `readCurrentContent`) — keeps this call agreeing with whichever
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
			diffHead: DiffHead,
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
					yield* resolveDiffBaseRef(repoRoot, session.baseRef),
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
				const diffHead = yield* resolveSessionDiffHead(session, repoRoot);
				const settings = yield* settingsStore.get();
				const includeUncommitted = settings.includeUncommitted;

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
					const currentContent = yield* readCurrentContent(
						repoRoot,
						diffHead,
						includeUncommitted,
						[path],
					);
					const contentOption = Option.fromNullishOr(currentContent.get(path));
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

				const currentContent = yield* readCurrentContent(
					repoRoot,
					diffHead,
					includeUncommitted,
					[path],
				);
				const contentOption = Option.fromNullishOr(currentContent.get(path));
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
			forkRevalidation: (
				session: Session,
				corrected: (outcome: OpenSessionOutcome) => Effect.Effect<void>,
			) =>
				revalidateSession(session).pipe(
					Effect.flatMap((outcome) =>
						outcome === undefined ? Effect.void : corrected(outcome),
					),
					Effect.catchCause((cause) =>
						Effect.logWarning(
							"PR index revalidation failed; keeping cached target",
							{ sessionId: session.id, cause },
						),
					),
					Effect.forkIn(scope),
					Effect.asVoid,
				),
			switchToPr,
			openPullRequestSession,
			recordRepoPath,
			listSessions,
			closeSession,
			resolveSessionRepoRoot,
			resolveScheduledMergeRepoRoot,
			listChangedFiles,
			refreshSessionBase,
			readBaseMayBeStale,
			readFileContents,
			readFileViewerContent,
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
		Layer.provideMerge(PrIndex.layer),
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
