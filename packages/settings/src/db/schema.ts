import {
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

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
	 * Scheme string of the user's preferred editor (`vscode`/`cursor`/`zed`/
	 * `windsurf` — see `apps/desktop/src-tauri/src/editors.rs`'s
	 * `CANDIDATE_EDITORS`), or `NULL` when never chosen. Plain text, not a
	 * typed column — same reasoning as `enabledHarnesses` above, this package
	 * stays independent of the frontend's/Rust's candidate list.
	 */
	preferredEditor: text(),
	/**
	 * Defaults to `false` at the column level (unlike `sidebarViewMode`/
	 * `diffStyleMode`, which are `NOT NULL` with no column default) — this
	 * field was added after those via `ALTER TABLE ADD COLUMN`, and SQLite
	 * rejects a `NOT NULL` column added that way with no default the moment
	 * the table already has a row, which any existing install's singleton
	 * `settings` row already does.
	 */
	hideReviewed: integer({ mode: "boolean" }).notNull().default(false),
	/** Same `ALTER TABLE ADD COLUMN` default story as `hideReviewed` above. */
	includeUncommitted: integer({ mode: "boolean" }).notNull().default(false),
	/** Same `ALTER TABLE ADD COLUMN` default story as `hideReviewed` above. */
	wrapLines: integer({ mode: "boolean" }).notNull().default(false),
	/**
	 * Gates the entire walkthrough feature (the tab, its keyboard shortcuts,
	 * and the harness configuration UI). Defaults to `false` — the walkthrough
	 * feature is currently unstable, so existing installs get it off after
	 * this migration runs. Same `ALTER TABLE ADD COLUMN` default story as
	 * `hideReviewed` above.
	 */
	walkthroughEnabled: integer({ mode: "boolean" }).notNull().default(false),
	/**
	 * Harness id of the last chat model the user actually sent a message
	 * with, paired with `lastChatModel` below — `HarnessModelCombobox`
	 * returns them together as one `ModelSelection`, not two independent
	 * settings. `NULL` until a thread's first send ever locks one in. Plain
	 * text, not a typed column — same reasoning as `enabledHarnesses` above,
	 * this package stays independent of `@repo/sidecar-api`'s `HarnessId`.
	 * Seeds the chat composer's picker on a fresh thread; the frontend
	 * re-validates the harness still exists and is enabled before using it
	 * — see `apps/desktop/src/components/chat-dock/chat-composer.tsx`.
	 */
	lastChatHarness: text(),
	/**
	 * Model id paired with `lastChatHarness` above, or `NULL` when the user
	 * sent with a harness but no specific model — a legitimate selection
	 * (`ModelSelection.modelId` is `string | undefined`), not "unset."
	 * Only meaningful alongside a non-`NULL` `lastChatHarness`; when set, the
	 * frontend re-validates it's still in the harness's live model list.
	 */
	lastChatModel: text(),
	updatedAt: integer({ mode: "timestamp_ms" })
		.notNull()
		.$defaultFn(() => new Date()),
});

/**
 * A learned `owner/repo` → local checkout path mapping — one row per repo
 * the user has opened a PR from, unlike `settings`' singleton row. Built up
 * as `pullRequests.open` resolves (or the user picks) a path; read back to
 * silently infer a sibling repo's path and to avoid re-prompting for one
 * already known. See `@repo/git`'s `repo-path-mapping.ts` for the
 * inference/verification logic this table's rows feed.
 */
export const repoPaths = sqliteTable(
	"repo_paths",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		owner: text().notNull(),
		repo: text().notNull(),
		path: text().notNull(),
		createdAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
		updatedAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("repo_paths_owner_repo_idx").on(table.owner, table.repo),
	],
);

/**
 * The merge method (`"merge" | "squash" | "rebase"`) the user last actually
 * merged a pull request with in a given `owner/repo` — one row per repo,
 * same keying as `repoPaths` above, but a distinct concern (a remembered UI
 * default, not a path mapping) so it gets its own table rather than a
 * column bolted onto `repoPaths`. GitHub exposes no per-repo default of its
 * own, so this is the only signal `mergeStatus`'s `defaultMethod` has beyond
 * `allowedMethods[0]`.
 */
export const repoMergeMethods = sqliteTable(
	"repo_merge_methods",
	{
		id: integer({ mode: "number" }).primaryKey({ autoIncrement: true }),
		owner: text().notNull(),
		repo: text().notNull(),
		/**
		 * `"merge" | "squash" | "rebase"`, plain text rather than a typed
		 * column — this package stays independent of `@repo/sidecar-api`'s
		 * `MergeMethod`, same reasoning as `enabledHarnesses` above. The
		 * sidecar's wiring layer is where "must be one of the three known
		 * methods" is actually enforced.
		 */
		method: text().notNull(),
		updatedAt: integer({ mode: "timestamp_ms" })
			.notNull()
			.$defaultFn(() => new Date()),
	},
	(table) => [
		uniqueIndex("repo_merge_methods_owner_repo_idx").on(
			table.owner,
			table.repo,
		),
	],
);

export type SettingsRow = typeof settings.$inferSelect;
export type RepoPathRow = typeof repoPaths.$inferSelect;
export type RepoMergeMethodRow = typeof repoMergeMethods.$inferSelect;
