import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per review session — regenerating overwrites rather than
 * accumulating history, matching `walkthrough.get`'s singular return. `sessionId`
 * is `@repo/review`'s `sessions.publicId` (a plain text column, not a declared
 * FK — see this package's AGENTS.md for why it doesn't import `@repo/review`'s
 * schema just to reference it).
 */
export const walkthroughs = sqliteTable("walkthroughs", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	sessionId: text().notNull().unique(),
	harness: text().notNull(),
	model: text(),
	/** JSON-serialized `Walkthrough` (`sections` + `references`) — see `../schema.ts`. */
	content: text().notNull(),
	/**
	 * JSON-serialized `Record<path, fingerprint>` — `@repo/git`'s
	 * `FileChange.fingerprint` per file, captured at generation time, so the
	 * frontend can compare against a session's *current* `diff.files` and mark
	 * individual references outdated without this package (or this table)
	 * needing to know how staleness is computed.
	 */
	fingerprints: text().notNull(),
	createdAt: integer({ mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer({ mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export type WalkthroughRow = typeof walkthroughs.$inferSelect;
