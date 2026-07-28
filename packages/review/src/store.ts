import { and, desc, eq, isNull } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { v7 as uuidv7 } from "uuid";
import { readBlob, writeBlob } from "./blob-store.ts";
import {
	dbUse,
	initDrizzle,
	openReviewDb,
	runMigrations,
} from "./db/client.ts";
import { reviewedFiles, type SessionRow, sessions } from "./db/schema.ts";
import { ReviewStoreError, SessionNotFound } from "./errors.ts";
import { getBlobsDir, getDataDirConfig, getReviewDbPath } from "./paths.ts";

export type Session = {
	readonly id: string;
	readonly repoRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly baseRef: string;
	readonly headRef: string;
	readonly pr: { readonly number: number; readonly title: string } | null;
};

export type OpenSessionInput = {
	readonly repoRoot: string;
	readonly owner: string;
	readonly repo: string;
	/** The PR's base branch, or the repo's default branch when there's no PR. */
	readonly baseRef: string;
	/** The PR's head branch, or the current branch when there's no PR. */
	readonly headRef: string;
	readonly pr: { readonly number: number; readonly title: string } | null;
};

export type FileReviewState = {
	readonly viewed: boolean;
	readonly snapshotHash: string | null;
};

/**
 * `sessions.open`'s idempotency key. Keyed by PR number when there is one;
 * by branch when there isn't, since a no-PR session has no PR number to key
 * on. Deliberately a single derived column rather than a composite unique
 * index — SQLite treats `NULL` as distinct within a unique index, so a
 * `(owner, repo, prNumber)` index would let every no-PR open insert a new row.
 */
const computeSessionKey = (
	owner: string,
	repo: string,
	pr: OpenSessionInput["pr"],
	headRef: string,
): string =>
	pr === null
		? `${owner}/${repo}#branch${headRef}`
		: `${owner}/${repo}#pr${pr.number}`;

const toSession = (row: SessionRow): Session => ({
	id: row.publicId,
	repoRoot: row.repoRoot,
	owner: row.owner,
	repo: row.repo,
	baseRef: row.baseRef,
	headRef: row.headRef,
	pr:
		row.prNumber === null
			? null
			: { number: row.prNumber, title: row.prTitle ?? "" },
});

const ensureDir = (fs: FileSystem, dir: string) =>
	fs
		.makeDirectory(dir, { recursive: true })
		.pipe(Effect.mapError((cause) => new ReviewStoreError({ cause })));

export class ReviewStore extends Context.Service<ReviewStore>()("ReviewStore", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		const dbPath = getReviewDbPath(dataDir);
		const blobsDir = getBlobsDir(dataDir);

		yield* ensureDir(fs, dataDir);
		yield* ensureDir(fs, blobsDir);

		const sqlite = yield* openReviewDb(dbPath);
		const db = yield* initDrizzle(sqlite);
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
					input.owner,
					input.repo,
					input.pr,
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
					owner: input.owner,
					repo: input.repo,
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

		/** Ticks a file Reviewed, snapshotting its current content immediately — see PLAN.md's Phase 1 note on why. */
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
					: { viewed: row.viewed, snapshotHash: row.snapshotHash };
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
						{ viewed: row.viewed, snapshotHash: row.snapshotHash },
					]),
				);
			});

		/** Reads a review snapshot's content back out of the blob store, for reconciliation's `diff(reviewed, head)`. */
		const readSnapshot = (
			hash: string,
		): Effect.Effect<Uint8Array, ReviewStoreError, FileSystem> =>
			readBlob(blobsDir, hash);

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
		};
	}),
}) {
	static layer = Layer.effect(ReviewStore, ReviewStore.make);
}
