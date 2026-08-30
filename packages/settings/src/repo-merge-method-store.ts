import { SqliteDb } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { runMigrations } from "./db/client.ts";
import { repoMergeMethods as repoMergeMethodsTable } from "./db/schema.ts";
import { SettingsStoreError } from "./errors.ts";

/**
 * The three merge strategies GitHub's PR UI offers. Defined locally rather
 * than imported from `@repo/sidecar-api`'s own `MergeMethod` — this package
 * stays dependency-free from the wire contract, same reasoning as
 * `Settings.enabledHarnesses` in `store.ts`. The sidecar's wiring layer is
 * where "must match one of GitHub's three known methods" is actually
 * enforced.
 */
export type MergeMethod = "merge" | "squash" | "rebase";

/**
 * The last merge method the user actually merged a pull request with in a
 * given `owner/repo`, remembered as the next default — GitHub exposes no
 * per-repo default of its own, so this is the only signal beyond GitHub's
 * fixed Merge → Squash → Rebase ordering. A separate `Context.Service` from
 * `SettingsStore` despite sharing its SQLite file and migration bundle: this
 * is a distinct concern (a remembered per-repo choice, not the singleton
 * preferences row or `repoPaths`' path mapping), so it gets its own module
 * and its own table rather than a method bolted onto `SettingsStore`.
 */
export class RepoMergeMethodStore extends Context.Service<RepoMergeMethodStore>()(
	"RepoMergeMethodStore",
	{
		make: Effect.gen(function* () {
			const db = yield* SqliteDb;
			// Same migration bundle as `SettingsStore` (this table lives in the
			// same package's `schema.ts`), applied here too rather than relying
			// on `SettingsStore.make` having already run it — `Layer.mergeAll`
			// gives no ordering guarantee between the two layers, and
			// `applyEmbeddedMigrations` is idempotent (tracked via its own
			// migrations table), so running it twice is a no-op past the first.
			yield* runMigrations(db);

			/** A drizzle query's own typed failure, re-mapped to this package's `SettingsStoreError` — the effect-native adapter already fails typed, so this is the only wrapping a query needs. */
			const query = <A, E>(effect: Effect.Effect<A, E>) =>
				effect.pipe(
					Effect.mapError((cause) => new SettingsStoreError({ cause })),
				);

			const row = (owner: string, repo: string) =>
				query(
					db
						.select()
						.from(repoMergeMethodsTable)
						.where(
							and(
								eq(repoMergeMethodsTable.owner, owner),
								eq(repoMergeMethodsTable.repo, repo),
							),
						)
						.limit(1),
				).pipe(Effect.map((rows) => rows.at(0)));

			/** The remembered merge method for `owner/repo`, or `null` when the user has never merged one there through nisi. */
			const get = (owner: string, repo: string) =>
				row(owner, repo).pipe(
					Effect.map((existing) =>
						existing === undefined ? null : (existing.method as MergeMethod),
					),
				);

			/** Records (or overwrites) the merge method last used for `owner/repo`. */
			const set = (owner: string, repo: string, method: MergeMethod) =>
				Effect.gen(function* () {
					const existing = yield* row(owner, repo);
					const updatedAt = new Date();
					if (existing === undefined) {
						yield* query(
							db
								.insert(repoMergeMethodsTable)
								.values({ owner, repo, method, updatedAt }),
						);
					} else {
						yield* query(
							db
								.update(repoMergeMethodsTable)
								.set({ method, updatedAt })
								.where(eq(repoMergeMethodsTable.id, existing.id)),
						);
					}
				});

			return { get, set };
		}),
	},
) {
	static layer = Layer.effect(RepoMergeMethodStore, RepoMergeMethodStore.make);
}
