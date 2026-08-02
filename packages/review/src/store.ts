import { SqliteDb } from "@repo/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { v7 as uuidv7 } from "uuid";
import { readBlob, writeBlob } from "./blob-store.ts";
import { dbUse, runMigrations } from "./db/client.ts";
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

		const { db } = yield* SqliteDb;
		yield* runMigrations(db);

		const readSessionRow = (sessionId: string) =>
			dbUse(db, (client) =>
				client
					.select()
					.from(sessions)
					.where(eq(sessions.publicId, sessionId))
					.limit(1)
					.all(),
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

				const existingRows = yield* dbUse(db, (client) =>
					client
						.select()
						.from(sessions)
						.where(eq(sessions.sessionKey, sessionKey))
						.limit(1)
						.all(),
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
						? yield* dbUse(db, (client) =>
								client
									.insert(sessions)
									.values({
										...sharedValues,
										publicId: uuidv7(),
										createdAt: now,
									})
									.returning()
									.get(),
							)
						: yield* dbUse(db, (client) =>
								client
									.update(sessions)
									.set(sharedValues)
									.where(eq(sessions.id, existing.id))
									.returning()
									.get(),
							);

				return toSession(row);
			});

		const listOpenSessions = (): Effect.Effect<
			ReadonlyArray<Session>,
			ReviewStoreError
		> =>
			dbUse(db, (client) =>
				client
					.select()
					.from(sessions)
					.where(isNull(sessions.closedAt))
					.orderBy(desc(sessions.updatedAt))
					.all(),
			).pipe(Effect.map((rows) => rows.map(toSession)));

		const closeSession = (
			sessionId: string,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError> =>
			Effect.gen(function* () {
				const row = yield* readSessionRow(sessionId);
				yield* dbUse(db, (client) =>
					client
						.update(sessions)
						.set({ closedAt: new Date() })
						.where(eq(sessions.id, row.id))
						.run(),
				);
			});

		const getSession = (
			sessionId: string,
		): Effect.Effect<Session, SessionNotFound | ReviewStoreError> =>
			readSessionRow(sessionId).pipe(Effect.map(toSession));

		/** Ticks a file Reviewed, snapshotting its current content immediately. */
		const markFileViewed = (
			sessionId: string,
			path: string,
			content: Uint8Array,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError, FileSystem> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const hash = yield* writeBlob(blobsDir, content);
				const now = new Date();
				yield* dbUse(db, (client) =>
					client
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
						})
						.run(),
				);
			});

		const markFileUnviewed = (
			sessionId: string,
			path: string,
		): Effect.Effect<void, SessionNotFound | ReviewStoreError> =>
			Effect.gen(function* () {
				const session = yield* readSessionRow(sessionId);
				const now = new Date();
				yield* dbUse(db, (client) =>
					client
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
						})
						.run(),
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
				const rows = yield* dbUse(db, (client) =>
					client
						.select()
						.from(reviewedFiles)
						.where(
							and(
								eq(reviewedFiles.sessionId, session.id),
								eq(reviewedFiles.path, path),
							),
						)
						.limit(1)
						.all(),
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
				const rows = yield* dbUse(db, (client) =>
					client
						.select()
						.from(reviewedFiles)
						.where(eq(reviewedFiles.sessionId, session.id))
						.all(),
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
				yield* dbUse(db, (client) =>
					client
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
						})
						.run(),
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
				yield* dbUse(db, (client) =>
					client
						.delete(reviewRangeClaims)
						.where(
							and(
								eq(reviewRangeClaims.sessionId, session.id),
								eq(reviewRangeClaims.path, path),
								eq(reviewRangeClaims.blockId, blockId),
							),
						)
						.run(),
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
				const rows = yield* dbUse(db, (client) =>
					client
						.select()
						.from(reviewRangeClaims)
						.where(
							and(
								eq(reviewRangeClaims.sessionId, session.id),
								eq(reviewRangeClaims.path, path),
							),
						)
						.all(),
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
			listOpenSessions,
			closeSession,
			getSession,
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
