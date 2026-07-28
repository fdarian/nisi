import { join } from "node:path";
import {
	FileNotChanged,
	type GhOutputDecodeError,
	type GitCommandError,
	type FileChange as GitFileChange,
	type FileContent as GitFileContent,
	getChangedFiles,
	getFileContent,
	type NoDefaultBranch,
	resolveCurrentBranch,
	resolveRepoRoot,
	resolveReviewTarget,
} from "@repo/git";
import {
	hashContent,
	type Reconciliation,
	type Session as ReviewSession,
	ReviewStore,
	type ReviewStoreError,
	reconcile,
	resolveReviewState,
	SessionNotFound,
} from "@repo/review";
import { Context, Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";

/** `sessions.open`'s `cwd` doesn't resolve to a git working tree. */
export class InvalidCwd extends Schema.TaggedErrorClass<InvalidCwd>()(
	"InvalidCwd",
	{
		cwd: Schema.String,
	},
) {}

export type Session = {
	readonly id: string;
	readonly repoRoot: string;
	readonly pr: {
		readonly number: number;
		readonly title: string;
		readonly baseRef: string;
		readonly headRef: string;
		readonly owner: string;
		readonly repo: string;
	} | null;
};

export type FileReview = {
	readonly viewed: boolean;
	readonly reviewedHash: string | null;
	readonly changedSinceReview: boolean;
};

/** `@repo/git`'s `FileChange` plus the review state Phase 1 shipped write-only — see `attachReviewState`. */
export type FileChange = GitFileChange & { readonly review: FileReview | null };

/** `@repo/git`'s `FileContent` plus Phase 2's reconciliation — see `readFileContent`. */
export type FileContent = GitFileContent & {
	readonly review: Reconciliation | null;
};

const toWireSession = (session: ReviewSession): Session => ({
	id: session.id,
	repoRoot: session.repoRoot,
	pr:
		session.pr === null
			? null
			: {
					number: session.pr.number,
					title: session.pr.title,
					baseRef: session.baseRef,
					headRef: session.headRef,
					owner: session.owner,
					repo: session.repo,
				},
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

		const openSession = (cwd: string) =>
			Effect.gen(function* () {
				const repoRoot = yield* resolveRepoRoot(cwd).pipe(
					Effect.catchTag("NotAGitRepository", () => new InvalidCwd({ cwd })),
				);
				const [reviewTarget, currentBranch] = yield* Effect.all([
					resolveReviewTarget(repoRoot),
					resolveCurrentBranch(repoRoot),
				]);
				const baseRef = reviewTarget.pr?.baseRef ?? reviewTarget.defaultBranch;
				const headRef = reviewTarget.pr?.headRef ?? currentBranch;

				const session = yield* reviewStore.openSession({
					repoRoot,
					owner: reviewTarget.owner,
					repo: reviewTarget.repo,
					baseRef,
					headRef,
					pr:
						reviewTarget.pr === null
							? null
							: {
									number: reviewTarget.pr.number,
									title: reviewTarget.pr.title,
								},
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
		 * The cheap half of review-vs-head comparison: hash the file's *current*
		 * worktree bytes and let the caller compare against a stored snapshot
		 * hash. A missing file (deleted since review) hashes as empty content,
		 * the same "diff against /dev/null" convention `setFileViewed` and
		 * `@repo/review`'s `reconcile` both use — not a swallowed error.
		 */
		const readHeadHash = (repoRoot: string, path: string) =>
			fs.readFile(join(repoRoot, path)).pipe(
				Effect.orElseSucceed(() => new Uint8Array()),
				Effect.map(hashContent),
			);

		/**
		 * Attaches each file's review state, looked up by its current path with
		 * a fallback to `oldPath` for a rename (a rename's `reviewed_files` row
		 * still lives under the pre-rename path — see `resolveReviewState`).
		 * `changedSinceReview` costs a worktree read + hash per file that
		 * actually has review state — bounded by how many files the user has
		 * ticked, not by the diff's total size, unlike the live-update poller's
		 * mtime/size-first discipline (which has to scan every changed file on
		 * every tick regardless of review state).
		 */
		const attachReviewState = (
			sessionId: string,
			repoRoot: string,
			files: ReadonlyArray<GitFileChange>,
		): Effect.Effect<
			ReadonlyArray<FileChange>,
			SessionNotFound | ReviewStoreError,
			FileSystem
		> =>
			Effect.gen(function* () {
				const states = yield* reviewStore.listReviewStates(sessionId);
				return yield* Effect.forEach(
					files,
					(file) =>
						Effect.gen(function* () {
							const state = resolveReviewState(states, file.path, file.oldPath);
							if (
								state === null ||
								!state.viewed ||
								state.snapshotHash === null
							) {
								return { ...file, review: null };
							}
							const headHash = yield* readHeadHash(repoRoot, file.path);
							const review: FileReview = {
								viewed: true,
								reviewedHash: state.snapshotHash,
								changedSinceReview: headHash !== state.snapshotHash,
							};
							return { ...file, review };
						}),
					{ concurrency: "unbounded" },
				);
			});

		const listChangedFiles = (sessionId: string) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const files = yield* getChangedFiles(session.repoRoot, session.baseRef);
				return yield* attachReviewState(sessionId, session.repoRoot, files);
			});

		/**
		 * `oldPath` — the file's pre-rename path, when it's a rename — mirrors
		 * `FileChange.oldPath` so a rename's review state resolves the same way
		 * here as it does in `listChangedFiles`'s `attachReviewState`.
		 *
		 * Reconciliation ranges are only computed when the patch content isn't
		 * size-gated (`!content.truncated`) — gated content can't be trusted
		 * for line-accurate ranges. `changedSinceReview` doesn't have that
		 * restriction: it's a hash compare against a direct worktree read, not
		 * derived from the (possibly gated) patch content, so it's always
		 * accurate even when `ranges` has to come back empty.
		 */
		const readFileContent = (
			sessionId: string,
			path: string,
			force: boolean,
			oldPath?: string,
		) =>
			Effect.gen(function* () {
				const session = yield* reviewStore.getSession(sessionId);
				const content = yield* getFileContent(
					session.repoRoot,
					session.baseRef,
					path,
					{ force },
				);

				const states = yield* reviewStore.listReviewStates(sessionId);
				const state = resolveReviewState(states, path, oldPath);
				if (state === null || !state.viewed || state.snapshotHash === null) {
					return { ...content, review: null };
				}

				const headHash = yield* readHeadHash(session.repoRoot, path);
				const changedSinceReview = headHash !== state.snapshotHash;

				if (content.truncated) {
					return { ...content, review: { changedSinceReview, ranges: [] } };
				}

				const reviewedBytes = yield* reviewStore.readSnapshot(
					state.snapshotHash,
				);
				const review = yield* reconcile(session.repoRoot, {
					baseContent: content.oldContent ?? "",
					reviewedContent: new TextDecoder().decode(reviewedBytes),
					headContent: content.newContent ?? "",
				});

				return { ...content, review };
			});

		/**
		 * Un-ticking Reviewed just clears the snapshot. Ticking it reads the
		 * file's *current worktree* content directly — this is a plain read, not
		 * `@repo/git`'s size-gated `getFileContent`, since a review snapshot's
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

		return {
			openSession,
			listSessions,
			closeSession,
			listChangedFiles,
			readFileContent,
			setFileViewed,
		};
	}),
}) {
	static layer = Layer.effect(Store, Store.make).pipe(
		Layer.provide(ReviewStore.layer),
	);
}

export type { GhOutputDecodeError, GitCommandError, NoDefaultBranch };
export { FileNotChanged, SessionNotFound };
