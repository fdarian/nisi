import { SqliteDb } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { dbUse, runMigrations } from "./db/client.ts";
import {
	type RepoPathRow,
	repoPaths as repoPathsTable,
	type SettingsRow,
	settings as settingsTable,
} from "./db/schema.ts";

export type SidebarViewMode = "tree" | "flat";
export type DiffStyleMode = "unified" | "split";

export type Settings = {
	/**
	 * Harness ids the user has declared configured locally — loose
	 * `string[]`, not `@repo/sidecar-api`'s `HarnessId[]`, since this package
	 * stays dependency-free from the wire contract. The sidecar's wiring
	 * layer is where membership in the known four ids is validated.
	 *
	 * `null` means "never configured" — distinct from `[]`, which is a
	 * deliberate choice to disable every harness. Callers that spawn off this
	 * value (see `apps/desktop/sidecar/walkthrough/harnesses.ts`) treat `null`
	 * as "every harness allowed," since the user hasn't restricted anything
	 * yet.
	 */
	readonly enabledHarnesses: ReadonlyArray<string> | null;
	readonly sidebarViewMode: SidebarViewMode;
	readonly diffStyleMode: DiffStyleMode;
	/** When true, files already marked reviewed are hidden from the files sidebar and the Files Changed list. */
	readonly hideReviewed: boolean;
	/**
	 * When true, uncommitted working-tree changes should be included alongside
	 * the PR's diff. Read server-side by `apps/desktop/sidecar/http.ts`'s
	 * `diff.files`/`diff.file` handlers (via the frontend's query input) and by
	 * `sidecar/walkthrough/context.ts`'s `gatherGenerationContext` (directly,
	 * since a walkthrough generation has no frontend request to carry it).
	 */
	readonly includeUncommitted: boolean;
};

export type SettingsUpdate = Partial<Settings>;

/** One learned `owner/repo` → local checkout path mapping — see `db/schema.ts`'s `repoPaths`. */
export type RepoPathMapping = {
	readonly owner: string;
	readonly repo: string;
	readonly path: string;
};

/**
 * What `get()` returns before any `update()` has ever been written.
 * `enabledHarnesses: null` keeps "never configured" distinguishable from
 * "configured, all four" — the walkthrough onboarding picker's first-use
 * gate depends on telling those apart. `sidebarViewMode`/`diffStyleMode`
 * still default to the sidecar's pre-Phase-4 behavior (tree sidebar, unified
 * diff) so shipping this store doesn't silently change those.
 */
export const DEFAULT_SETTINGS: Settings = {
	enabledHarnesses: null,
	sidebarViewMode: "tree",
	diffStyleMode: "unified",
	hideReviewed: false,
	includeUncommitted: false,
};

const toSettings = (row: SettingsRow): Settings => ({
	enabledHarnesses:
		row.enabledHarnesses === null
			? null
			: (JSON.parse(row.enabledHarnesses) as ReadonlyArray<string>),
	sidebarViewMode: row.sidebarViewMode as SidebarViewMode,
	diffStyleMode: row.diffStyleMode as DiffStyleMode,
	hideReviewed: row.hideReviewed,
	includeUncommitted: row.includeUncommitted,
});

const toRepoPathMapping = (row: RepoPathRow): RepoPathMapping => ({
	owner: row.owner,
	repo: row.repo,
	path: row.path,
});

/**
 * A handful of user preferences the sidecar itself needs to read — enabled
 * harnesses at minimum, since `walkthrough.harnesses()` runs in the sidecar
 * process, not the webview, so it can't be `localStorage` the way theme is.
 * One singleton row, typed accessors, no config framework: `get()` defaults
 * when unset, `update()` merges a partial patch over the current row so
 * untouched fields survive.
 */
export class SettingsStore extends Context.Service<SettingsStore>()(
	"SettingsStore",
	{
		make: Effect.gen(function* () {
			const { db } = yield* SqliteDb;
			yield* runMigrations(db);

			const readRow = () =>
				dbUse(db, (client) =>
					client.select().from(settingsTable).limit(1).all(),
				);

			const get = () =>
				readRow().pipe(
					Effect.map((rows) => {
						const row = rows.at(0);
						return row === undefined ? DEFAULT_SETTINGS : toSettings(row);
					}),
				);

			const update = (patch: SettingsUpdate) =>
				Effect.gen(function* () {
					const existingRows = yield* readRow();
					const existing = existingRows.at(0);
					const current =
						existing === undefined ? DEFAULT_SETTINGS : toSettings(existing);
					const next: Settings = { ...current, ...patch };

					const values = {
						enabledHarnesses:
							next.enabledHarnesses === null
								? null
								: JSON.stringify(next.enabledHarnesses),
						sidebarViewMode: next.sidebarViewMode,
						diffStyleMode: next.diffStyleMode,
						hideReviewed: next.hideReviewed,
						includeUncommitted: next.includeUncommitted,
						updatedAt: new Date(),
					};

					if (existing === undefined) {
						yield* dbUse(db, (client) =>
							client.insert(settingsTable).values(values).run(),
						);
					} else {
						yield* dbUse(db, (client) =>
							client
								.update(settingsTable)
								.set(values)
								.where(eq(settingsTable.id, existing.id))
								.run(),
						);
					}

					return next;
				});

			const repoPathRow = (owner: string, repo: string) =>
				dbUse(db, (client) =>
					client
						.select()
						.from(repoPathsTable)
						.where(
							and(
								eq(repoPathsTable.owner, owner),
								eq(repoPathsTable.repo, repo),
							),
						)
						.limit(1)
						.all(),
				).pipe(Effect.map((rows) => rows.at(0)));

			/** The known local checkout path for `owner/repo`, or `null` when nothing's been recorded for it yet. */
			const getRepoPath = (owner: string, repo: string) =>
				repoPathRow(owner, repo).pipe(Effect.map((row) => row?.path ?? null));

			/**
			 * Records (or overwrites) the local checkout path for `owner/repo` —
			 * the caller (the sidecar's `pullRequests.recordRepoPath`/inference
			 * flow) is responsible for having already verified the path's
			 * `origin` actually matches before calling this; this store just
			 * persists whatever it's given, same as `update()` does for the
			 * singleton settings row.
			 */
			const setRepoPath = (owner: string, repo: string, path: string) =>
				Effect.gen(function* () {
					const existing = yield* repoPathRow(owner, repo);
					const updatedAt = new Date();
					if (existing === undefined) {
						yield* dbUse(db, (client) =>
							client
								.insert(repoPathsTable)
								.values({ owner, repo, path, updatedAt })
								.run(),
						);
					} else {
						yield* dbUse(db, (client) =>
							client
								.update(repoPathsTable)
								.set({ path, updatedAt })
								.where(eq(repoPathsTable.id, existing.id))
								.run(),
						);
					}
				});

			/** Every known `owner/repo` → path mapping — the candidate set `@repo/git`'s `inferRepoPath` guesses a sibling from. */
			const listRepoPaths = () =>
				dbUse(db, (client) => client.select().from(repoPathsTable).all()).pipe(
					Effect.map((rows) => rows.map(toRepoPathMapping)),
				);

			return { get, update, getRepoPath, setRepoPath, listRepoPaths };
		}),
	},
) {
	static layer = Layer.effect(SettingsStore, SettingsStore.make);
}
