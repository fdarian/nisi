import { SqliteDb } from "@repo/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { v7 as uuidv7 } from "uuid";
import { readBlob, writeBlob } from "./blob-store.ts";
import { runMigrations } from "./db/client.ts";
import {
	reviewedFiles,
	reviewRangeClaims,
	type SessionRow,
	sessions,
} from "./db/schema.ts";
import { ReviewStoreError, SessionNotFound } from "./errors.ts";
import { getBlobsDir, getDataDirConfig } from "./paths.ts";

/**
 * The GitHub side of a session, present only when there's an open PR — its
 * `owner`/`repo` live here rather than at the top level because a repo with
 * no GitHub origin has no such identity to record, and a nullable pair of
 * columns shouldn't be readable as anything but "no PR".
 */
export type SessionPullRequest = {
	readonly number: number;
	readonly title: string;
	readonly owner: string;
	readonly repo: string;
};

export type Session = {
	readonly id: string;
	readonly repoRoot: string;
	readonly baseRef: string;
	readonly headRef: string;
	readonly pr: SessionPullRequest | null;
};

export type OpenSessionInput = {
	readonly repoRoot: string;
	/** The PR's base branch, or the repo's default branch when there's no PR. */
	readonly baseRef: string;
	/** The PR's head branch, or the current branch when there's no PR. */
	readonly headRef: string;
	readonly pr: SessionPullRequest | null;
};

/**
 * `retargetToPullRequest`'s result — the caller (`apps/desktop/sidecar/store.ts`'s
 * `switchToPr`) needs to tell "the row was retargeted in place" apart from
 * "a different, pre-existing row already held this PR" to decide what else
 * needs to happen (the sidecar's walkthrough live-session/chat-thread/watch
 * cleanup for a genuinely-closed source session lives outside this package —
 * see that file). `"existing"` names the outcome, not a verdict on whether
 * anything went wrong: reviewing the same PR from two different branches
 * (or reopening one after closing it) legitimately converges on one session.
 */
export type RetargetToPullRequestResult =
	| { readonly kind: "retargeted"; readonly session: Session }
	| { readonly kind: "existing"; readonly session: Session };

export type FileReviewState = {
	readonly viewed: boolean;
	readonly snapshotHash: string | null;
	/** Epoch ms this row was last written — lets a caller reconciling this claim alongside range claims (see `RangeReviewClaim`) tie-break attribution by recency. */
	readonly viewedAt: number;
};

export type LineRange = {
	readonly startLine: number;
	readonly endLine: number;
};

/** One walkthrough reference block's claim on a set of ranges within one file — see `db/schema.ts`'s `reviewRangeClaims`. */
export type RangeReviewClaim = {
	readonly path: string;
	readonly blockId: string;
	readonly blockLabel: string;
	readonly ranges: ReadonlyArray<LineRange>;
	readonly snapshotHash: string;
	readonly viewedAt: number;
};

/**
 * `sessions.open`'s idempotency key: the working tree, narrowed by the PR
 * open on it, or by the branch *and* base when there is no PR. The base is
 * part of the key, not just the branch — `nisi diff <base>` lets a caller
 * pick an arbitrary base ref on the same branch (see `packages/cli`), and
 * two different bases reviewed from the same branch are two distinct
 * reviews of two distinct diffs, not one session that silently repoints its
 * reviewed snapshots underneath whichever base opened last. Rooted at
 * `repoRoot` rather than the GitHub repo because review state is a set of
 * snapshots of *these* files — two clones or worktrees of the same upstream
 * hold different bytes, so reviewing one must not repoint the other's
 * session. Deliberately a single derived column rather than a composite
 * unique index: SQLite treats `NULL` as distinct within a unique index, so
 * anything involving a nullable `prNumber` would let every no-PR open insert
 * a new row.
 */
const computeSessionKey = (
	repoRoot: string,
	pr: OpenSessionInput["pr"],
	baseRef: string,
	headRef: string,
): string =>
	pr === null
		? `${repoRoot}#branch${headRef}#base${baseRef}`
		: `${repoRoot}#pr${pr.number}`;

/** A PR is all four columns or none — a partially-filled row is a row we can't describe, not a PR with blanks. */
const toPullRequest = (row: SessionRow): SessionPullRequest | null =>
	row.prNumber === null ||
	row.prTitle === null ||
	row.owner === null ||
	row.repo === null
		? null
		: {
				number: row.prNumber,
				title: row.prTitle,
				owner: row.owner,
				repo: row.repo,
			};

const toSession = (row: SessionRow): Session => ({
	id: row.publicId,
	repoRoot: row.repoRoot,
	baseRef: row.baseRef,
	headRef: row.headRef,
	pr: toPullRequest(row),
});

const ensureDir = (fs: FileSystem, dir: string) =>
	fs
		.makeDirectory(dir, { recursive: true })
		.pipe(Effect.mapError((cause) => new ReviewStoreError({ cause })));

export class ReviewStore extends Context.Service<ReviewStore>()("ReviewStore", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		const blobsDir = getBlobsDir(dataDir);

		yield* ensureDir(fs, blobsDir);

		const db = yield* SqliteDb;
		yield* runMigrations(db);

		/** A drizzle query's own typed failure, re-mapped to this store's `ReviewStoreError` — the effect-native adapter already fails typed, so this is the only wrapping a query needs. */
		const query = <A, E>(effect: Effect.Effect<A, E>) =>
			effect.pipe(Effect.mapError((cause) => new ReviewStoreError({ cause })));

		const readSessionRow = (sessionId: string) =>
			query(
				db
					.select()
					.from(sessions)
					.where(eq(sessions.publicId, sessionId))
					.limit(1),
			).pipe(
				Effect.flatMap((rows) => {
					const row = rows.at(0);
					return row === undefined
						? Effect.fail(new SessionNotFound({ sessionId }))
						: Effect.succeed(row);
				}),
			);

		const openSession = (
			input: OpenSessionInput,
		): Effect.Effect<Session, ReviewStoreError> =>
			Effect.gen(function* () {
				const sessionKey = computeSessionKey(
					input.repoRoot,
					input.pr,
					input.baseRef,
					input.headRef,
				);
				const now = new Date();

				const existingRows = yield* query(
					db
						.select()
						.from(sessions)
						.where(eq(sessions.sessionKey, sessionKey))
						.limit(1),
				);
				const existing = existingRows.at(0);

				const sharedValues = {
					sessionKey,
					repoRoot: input.repoRoot,
					owner: input.pr?.owner ?? null,
					repo: input.pr?.repo ?? null,
					prNumber: input.pr?.number ?? null,
					prTitle: input.pr?.title ?? null,
					baseRef: input.baseRef,
					headRef: input.headRef,
					closedAt: null,
					updatedAt: now,
				};

				const row =
					existing === undefined
						? yield* query(
								db
									.insert(sessions)
									.values({
										...sharedValues,
										publicId: uuidv7(),
										createdAt: now,
									})
									.returning()
									.get(),
							)
						: yield* query(
								db
									.update(sessions)
									.set(sharedValues)
									.where(eq(sessions.id, existing.id))
									.returning()
									.get(),
							);

				return toSession(row);
			});

		/**
		 * "Switch to PR": retargets `sessionId`'s row onto `pr` in place — same
		 * `id`, `sessionKey`/`owner`/`repo`/`prNumber`/`prTitle`/`baseRef`/
		 * `headRef` overwritten to the PR's — so every dependent table
		 * (`reviewed_files`, `review_range_claims`, a stored walkthrough keyed
		 * by this same `publicId`) carries over with no migration or copy.
		 * Unlike `openSession`, this never inserts: the row named by
		 * `sessionId` already exists (or this fails `SessionNotFound`), so
		 * there's nothing to get-or-create.
		 *
		 * The one thing that *can* go wrong is the PR's own `sessionKey`
		 * already belonging to a different row — another session already
		 * reviewing this PR, from a second worktree, a second branch pushed to
		 * the same PR, or a previous "Switch to PR" that was never closed. A
		 * row whose `closedAt` is set still counts as occupying the key here
		 * (`sessions.sessionKey` is `UNIQUE` regardless of `closedAt`, so it
		 * physically does), rather than being treated as free for `sessionId`
		 * to claim: reopening-by-reuse is squarely `openSession`'s job for
		 * *every* other key, and giving this one path a different rule for a
		 * closed row would mean two sessions could resurrect the same PR
		 * identity independently and disagree about which one's the "real"
		 * reopen. So a closed collision is reactivated (its `closedAt`
		 * cleared) exactly the way `openSession` already reopens any other
		 * closed row, and `sessionId`'s own row is left untouched — the
		 * caller decides whether to close it (see `kind: "existing"` above).
		 *
		 * The collision check and whichever write follows it happen inside one
		 * transaction, so two concurrent "Switch to PR" calls converging on
		 * the same PR can't both observe no collision and both try to claim
		 * the key (`sessionKey`'s own `UNIQUE` constraint would catch that
		 * anyway, but as a write failure instead of the discriminated result
		 * this signature promises).
		 */
		const retargetToPullRequest = (
			sessionId: string,
			pr: SessionPullRequest,
			baseRef: string,
			headRef: string,
		): Effect.Effect<
			RetargetToPullRequestResult,
			SessionNotFound | ReviewStoreError
		> =>
			Effect.gen(function* () {
				const source = yield* readSessionRow(sessionId);
				const targetKey = computeSessionKey(
					source.repoRoot,
					pr,
					baseRef,
					headRef,
				);
				const now = new Date();

				return yield* query(
					db.transaction((tx) =>
						Effect.gen(function* () {
							const collisionRows = yield* tx
								.select()
								.from(sessions)
								.where(eq(sessions.sessionKey, targetKey))
								.limit(1);
							const collision = collisionRows.at(0);

							if (collision !== undefined && collision.id !== source.id) {
								const existing =
									collision.closedAt === null
										? collision
										: yield* tx
												.update(sessions)
												.set({ closedAt: null, updatedAt: now })
												.where(eq(sessions.id, collision.id))
												.returning()
												.get();
								return {
									kind: "existing" as const,
									session: toSession(existing),
								};
							}

							const retargeted = yield* tx
								.update(sessions)
								.set({
									sessionKey: targetKey,
									owner: pr.owner,
									repo: pr.repo,
									prNumber: pr.number,
									prTitle: pr.title,
									baseRef,
									headRef,
									updatedAt: now,
								})
								.where(eq(sessions.id, source.id))
								.returning()
								.get();
							return {
								kind: "retargeted" as const,
								session: toSession(retargeted),
							};
						}),
					),
				);
			});

		const listOpenSessions = (): Effect.Effect<
			ReadonlyArray<Session>,
			ReviewStoreError
		> =>
			query(
				db
					.select()
					.from(sessions)
					.where(isNull(sessions.closedAt))
					.orderBy(desc(sessions.updatedAt)),
			).pipe(Effect.map((rows) => rows.map(toSession)));

		const closeSession = (
			sessionId: string,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError> =>
			Effect.gen(function* () {
				const row = yield* readSessionRow(sessionId);
				yield* query(
					db
						.update(sessions)
						.set({ closedAt: new Date() })
						.where(eq(sessions.id, row.id)),
				);
			});

		const getSession = (
			sessionId: string,
		): Effect.Effect<Session, SessionNotFound | ReviewStoreError> =>
			readSessionRow(sessionId).pipe(Effect.map(toSession));

		/**
		 * Repoints an already-open session's `repoRoot` to a worktree's new
		 * location — called by `apps/desktop/sidecar/store.ts` once `@repo/git`'s
		 * `revalidateWorktreePath` confirms, via `git worktree list --porcelain`,
		 * that the persisted path just moved rather than vanished (a `git
		 * worktree move`, or an external tool like `wt`/worktrunk, relocating a
		 * worktree nisi created). Deliberately doesn't touch `sessionKey` — that
		 * stays rooted at the `repoRoot` the session was originally opened under
		 * (see its own doc comment for why), not a live address to keep in sync;
		 * this only updates where the *same* open session's files currently live.
		 */
		const updateRepoRoot = (
			sessionId: string,
			repoRoot: string,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError> =>
			Effect.gen(function* () {
				const row = yield* readSessionRow(sessionId);
				yield* query(
					db
						.update(sessions)
						.set({ repoRoot, updatedAt: new Date() })
						.where(eq(sessions.id, row.id)),
				);
			});

		/**
		 * Ticks a file Reviewed, snapshotting its current content immediately.
		 * `content: Option.none()` means the file was absent from the working
		 * tree at tick time (deleted, or never existed) — no blob is written
		 * and the row's `snapshotHash` is persisted as `NULL` rather than
		 * `sha256("")`, so "reviewed while absent" and "reviewed a genuinely
		 * empty file" stay two distinct, honestly-comparable claims. See
		 * `reviewedFiles.snapshotHash`'s column comment.
		 */
		const markFileViewed = (
			sessionId: string,
			path: string,
			content: Option.Option<Uint8Array>,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError, FileSystem> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const hash = Option.isSome(content)
					? yield* writeBlob(blobsDir, content.value)
					: null;
				const now = new Date();
				yield* query(
					db
						.insert(reviewedFiles)
						.values({
							sessionId: session.id,
							path,
							viewed: true,
							snapshotHash: hash,
							viewedAt: now,
						})
						.onConflictDoUpdate({
							target: [reviewedFiles.sessionId, reviewedFiles.path],
							set: { viewed: true, snapshotHash: hash, viewedAt: now },
						}),
				);
			});

		const markFileUnviewed = (
			sessionId: string,
			path: string,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const now = new Date();
				yield* query(
					db
						.insert(reviewedFiles)
						.values({
							sessionId: session.id,
							path,
							viewed: false,
							snapshotHash: null,
							viewedAt: now,
						})
						.onConflictDoUpdate({
							target: [reviewedFiles.sessionId, reviewedFiles.path],
							set: { viewed: false, snapshotHash: null, viewedAt: now },
						}),
				);
			});

		const getFileReviewState = (
			sessionId: string,
			path: string,
		): Effect.Effect<
			FileReviewState | null,
			SessionNotFound | ReviewStoreError
		> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const rows = yield* query(
					db
						.select()
						.from(reviewedFiles)
						.where(
							and(
								eq(reviewedFiles.sessionId, session.id),
								eq(reviewedFiles.path, path),
							),
						)
						.limit(1),
				);
				const row = rows.at(0);
				return row === undefined
					? null
					: {
							viewed: row.viewed,
							snapshotHash: row.snapshotHash,
							viewedAt: row.viewedAt.getTime(),
						};
			});

		/**
		 * Every reviewed-file row for a session, keyed by path, in one query —
		 * `diff.files` needs review state for every file in the diff at once,
		 * so this avoids an N-query round trip (one `getFileReviewState` per
		 * file) for what's otherwise the same data.
		 */
		const listReviewStates = (
			sessionId: string,
		): Effect.Effect<
			ReadonlyMap<string, FileReviewState>,
			SessionNotFound | ReviewStoreError
		> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const rows = yield* query(
					db
						.select()
						.from(reviewedFiles)
						.where(eq(reviewedFiles.sessionId, session.id)),
				);
				return new Map(
					rows.map((row) => [
						row.path,
						{
							viewed: row.viewed,
							snapshotHash: row.snapshotHash,
							viewedAt: row.viewedAt.getTime(),
						},
					]),
				);
			});

		/** Reads a review snapshot's content back out of the blob store, for reconciliation's `diff(reviewed, head)`. */
		const readSnapshot = (
			hash: string,
		): Effect.Effect<Uint8Array, ReviewStoreError, FileSystem> =>
			readBlob(blobsDir, hash);

		/**
		 * Ticks one walkthrough reference block's claim on a set of ranges
		 * within one file, snapshotting the *whole file's* current content —
		 * same "snapshot immediately" discipline as `markFileViewed`, so
		 * reconciliation always has real content to diff against. Re-ticking the
		 * same block+path updates the existing claim in place (new ranges, new
		 * snapshot, new `viewedAt`) rather than accumulating history.
		 */
		const markRangeViewed = (
			sessionId: string,
			path: string,
			blockId: string,
			blockLabel: string,
			ranges: ReadonlyArray<LineRange>,
			content: Uint8Array,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError, FileSystem> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const hash = yield* writeBlob(blobsDir, content);
				const now = new Date();
				yield* query(
					db
						.insert(reviewRangeClaims)
						.values({
							sessionId: session.id,
							path,
							blockId,
							blockLabel,
							ranges: JSON.stringify(ranges),
							snapshotHash: hash,
							viewedAt: now,
						})
						.onConflictDoUpdate({
							target: [
								reviewRangeClaims.sessionId,
								reviewRangeClaims.path,
								reviewRangeClaims.blockId,
							],
							set: {
								blockLabel,
								ranges: JSON.stringify(ranges),
								snapshotHash: hash,
								viewedAt: now,
							},
						}),
				);
			});

		/**
		 * Unticks one block's claim. Unlike `markFileUnviewed`, this deletes the
		 * row outright rather than flipping a `viewed` flag — a range claim's
		 * only reason to exist is being an active claim, so there's no
		 * "unviewed but remembered" state to preserve.
		 */
		const unmarkRangeViewed = (
			sessionId: string,
			path: string,
			blockId: string,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				yield* query(
					db
						.delete(reviewRangeClaims)
						.where(
							and(
								eq(reviewRangeClaims.sessionId, session.id),
								eq(reviewRangeClaims.path, path),
								eq(reviewRangeClaims.blockId, blockId),
							),
						),
				);
			});

		/** Every active range claim on one file, for reconciliation — mirrors `listReviewStates`' per-session bulk read, scoped to a path since (unlike the whole-file toggle) nothing else needs every path's claims at once. */
		const listRangeClaims = (
			sessionId: string,
			path: string,
		): Effect.Effect<
			ReadonlyArray<RangeReviewClaim>,
			SessionNotFound | ReviewStoreError
		> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const rows = yield* query(
					db
						.select()
						.from(reviewRangeClaims)
						.where(
							and(
								eq(reviewRangeClaims.sessionId, session.id),
								eq(reviewRangeClaims.path, path),
							),
						),
				);
				return rows.map(
					(row): RangeReviewClaim => ({
						path: row.path,
						blockId: row.blockId,
						blockLabel: row.blockLabel,
						ranges: JSON.parse(row.ranges) as ReadonlyArray<LineRange>,
						snapshotHash: row.snapshotHash,
						viewedAt: row.viewedAt.getTime(),
					}),
				);
			});

		return {
			openSession,
			retargetToPullRequest,
			listOpenSessions,
			closeSession,
			getSession,
			updateRepoRoot,
			markFileViewed,
			markFileUnviewed,
			getFileReviewState,
			listReviewStates,
			readSnapshot,
			markRangeViewed,
			unmarkRangeViewed,
			listRangeClaims,
		};
	}),
}) {
	static layer = Layer.effect(ReviewStore, ReviewStore.make);
}
