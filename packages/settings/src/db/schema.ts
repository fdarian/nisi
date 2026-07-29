import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Singleton row — at most one ever exists. `SettingsStore.get()` returns
 * `DEFAULT_SETTINGS` when no row exists yet rather than requiring a seed
 * migration; `update()` inserts the first row on first write, same
 * read-then-insert-or-update shape as `@repo/review`'s `sessions.open`.
 */
export const settings = sqliteTable("settings", {
	id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
	/**
	 * JSON-encoded string[] of harness ids the user has declared configured
	 * locally, or `NULL` when never configured — distinct from an empty JSON
	 * array (`"[]"`), a deliberate choice to disable every harness. Stored as
	 * plain text, not a typed column — this package stays independent of
	 * `@repo/sidecar-api`'s `HarnessId`, same as `@repo/walkthrough`'s
	 * `harness` column in `apps/desktop/sidecar`'s `WalkthroughStore`. The
	 * wire boundary is where "must be one of the four known ids" is actually
	 * enforced.
	 */
	enabledHarnesses: text(),
	sidebarViewMode: text().notNull(),
	diffStyleMode: text().notNull(),
	/**
	 * Defaults to `false` at the column level (unlike `sidebarViewMode`/
	 * `diffStyleMode`, which are `NOT NULL` with no column default) — this
	 * field was added after those via `ALTER TABLE ADD COLUMN`, and SQLite
	 * rejects a `NOT NULL` column added that way with no default the moment
	 * the table already has a row, which any existing install's singleton
	 * `settings` row already does.
	 */
	hideReviewed: integer({ mode: "boolean" }).notNull().default(false),
	updatedAt: integer({ mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
});

export type SettingsRow = typeof settings.$inferSelect;
