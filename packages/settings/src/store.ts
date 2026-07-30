import { SqliteDb } from "@repo/db";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { dbUse, runMigrations } from "./db/client.ts";
import { type SettingsRow, settings as settingsTable } from "./db/schema.ts";

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
};

export type SettingsUpdate = Partial<Settings>;

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
};

const toSettings = (row: SettingsRow): Settings => ({
	enabledHarnesses:
		row.enabledHarnesses === null
			? null
			: (JSON.parse(row.enabledHarnesses) as ReadonlyArray<string>),
	sidebarViewMode: row.sidebarViewMode as SidebarViewMode,
	diffStyleMode: row.diffStyleMode as DiffStyleMode,
	hideReviewed: row.hideReviewed,
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

			return { get, update };
		}),
	},
) {
	static layer = Layer.effect(SettingsStore, SettingsStore.make);
}
