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
	 * Dedup key `sessions.open` upserts on: `${owner}/${repo}#pr${number}`, or
	 * `${owner}/${repo}#branch${headRef}` for the no-PR fallback. A plain
	 * composite unique index on `(owner, repo, prNumber)` doesn't work here —
	 * SQLite treats `NULL` as distinct in unique indexes, so every no-PR open
	 * would insert a fresh row instead of reusing one.
	 */
	sessionKey: text().notNull().unique(),
	repoRoot: text().notNull(),
	owner: text().notNull(),
	repo: text().notNull(),
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

export type SessionRow = typeof sessions.$inferSelect;
export type ReviewedFileRow = typeof reviewedFiles.$inferSelect;
