import {
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	publicId: text().notNull().unique(),
	/**
	 * Dedup key `sessions.open` upserts on: `${repoRoot}#pr${number}`, or
	 * `${repoRoot}#branch${headRef}` for the no-PR fallback. Rooted at the
	 * working tree, not the GitHub repo — review state is snapshots of *these*
	 * files, so two clones or worktrees of one upstream are two reviews. A
	 * plain composite unique index doesn't work here anyway: SQLite treats
	 * `NULL` as distinct in unique indexes, so every no-PR open would insert a
	 * fresh row instead of reusing one.
	 */
	sessionKey: text().notNull().unique(),
	repoRoot: text().notNull(),
	/** PR-scoped, all four together or none: a repo with no GitHub origin (or none `gh` can resolve) still opens a session. */
	owner: text(),
	repo: text(),
	prNumber: integer({ mode: "number" }),
	prTitle: text(),
	baseRef: text().notNull(),
	headRef: text().notNull(),
	/** Null while the session is an open tab; set by `sessions.close`, cleared by the next `sessions.open`. */
	closedAt: integer({ mode: "timestamp_ms" }),
	createdAt: integer({ mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer({ mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export const reviewedFiles = sqliteTable(
	"reviewed_files",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		sessionId: integer({ mode: "number" })
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		path: text().notNull(),
		viewed: integer({ mode: "boolean" }).notNull(),
		/** sha256 hex of the snapshot blob in the content-addressed store; null when `viewed` is false. */
		snapshotHash: text(),
		viewedAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("reviewed_files_session_path_idx").on(
			table.sessionId,
			table.path,
		),
	],
);

/**
 * One walkthrough reference block's claim on a set of line ranges within
 * one file — Phase 3's range-scoped review, additive alongside
 * `reviewedFiles`' whole-file toggle rather than unified into it. Unlike
 * `reviewedFiles` (one mutable row per session+path, upserted in place),
 * a file can carry several simultaneous claims from different blocks, so
 * this is a genuine one-row-per-claim table keyed by
 * `(sessionId, path, blockId)` — ticking the same block+path again updates
 * that row in place; unticking deletes it outright (there's no "unviewed"
 * state to remember the way `reviewedFiles.viewed` does, since the claim's
 * only reason to exist is being an active range).
 */
export const reviewRangeClaims = sqliteTable(
	"review_range_claims",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		sessionId: integer({ mode: "number" })
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		path: text().notNull(),
		blockId: text().notNull(),
		/** Denormalized snapshot of the block's label at tick time, for the "reviewed in `<label>`" marker — this package has no dependency on `@repo/walkthrough` to look it back up. */
		blockLabel: text().notNull(),
		/** JSON-encoded `Array<{startLine, endLine}>`, 1-based inclusive, in the snapshot's own coordinates (== head coordinates at tick time) — see `reconcile.ts`'s `ReviewClaim`. */
		ranges: text().notNull(),
		/** sha256 hex of the snapshot blob in the content-addressed store — the whole file's content at tick time, same as `reviewedFiles.snapshotHash`. */
		snapshotHash: text().notNull(),
		viewedAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("review_range_claims_session_path_block_idx").on(
			table.sessionId,
			table.path,
			table.blockId,
		),
	],
);

export type SessionRow = typeof sessions.$inferSelect;
export type ReviewedFileRow = typeof reviewedFiles.$inferSelect;
export type ReviewRangeClaimRow = typeof reviewRangeClaims.$inferSelect;
