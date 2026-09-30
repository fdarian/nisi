import { SqliteDb } from "@repo/db";
import { and, eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";
import { runMigrations } from "./db/client.ts";
import { scheduledMerges } from "./db/schema.ts";
import { SettingsStoreError } from "./errors.ts";
import type { MergeMethod } from "./repo-merge-method-store.ts";

export type ScheduledMergeKey = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};
export type ScheduledMerge = ScheduledMergeKey & {
	readonly repoRoot: string;
	readonly method: MergeMethod;
	readonly route: "merge" | "stack";
	readonly createdAt: Date;
};

const StoredMethod = Schema.Literals(["merge", "squash", "rebase"]);
const StoredRoute = Schema.Literals(["merge", "stack"]);
const whereKey = (key: ScheduledMergeKey) =>
	and(
		eq(scheduledMerges.owner, key.owner),
		eq(scheduledMerges.repo, key.repo),
		eq(scheduledMerges.number, key.number),
	);

export class ScheduledMergeStore extends Context.Service<ScheduledMergeStore>()(
	"ScheduledMergeStore",
	{
		make: Effect.gen(function* () {
			const db = yield* SqliteDb;
			yield* runMigrations(db);
			const query = <A, E>(effect: Effect.Effect<A, E>) =>
				effect.pipe(
					Effect.mapError((cause) => new SettingsStoreError({ cause })),
				);
			const decode = (row: typeof scheduledMerges.$inferSelect) =>
				query(
					Effect.all([
						Schema.decodeUnknownEffect(StoredMethod)(row.method),
						Schema.decodeUnknownEffect(StoredRoute)(row.route),
					]),
				).pipe(
					Effect.map(
						(values): ScheduledMerge => ({
							owner: row.owner,
							repo: row.repo,
							number: row.number,
							repoRoot: row.repo_root,
							method: values[0],
							route: values[1],
							createdAt: row.created_at,
						}),
					),
				);
			const list = () =>
				query(db.select().from(scheduledMerges)).pipe(
					Effect.flatMap((rows) => Effect.forEach(rows, decode)),
				);
			const get = (key: ScheduledMergeKey) =>
				query(
					db.select().from(scheduledMerges).where(whereKey(key)).limit(1),
				).pipe(
					Effect.flatMap((rows) => {
						const row = rows.at(0);
						return row === undefined ? Effect.succeed(null) : decode(row);
					}),
				);
			const clock = { lastCreatedAt: Date.now() };
			const put = (input: Omit<ScheduledMerge, "createdAt">) =>
				Effect.gen(function* () {
					const previous = yield* get(input);
					// Replacement within one millisecond must invalidate an in-flight snapshot.
					const createdAt = new Date(
						Math.max(
							Date.now(),
							clock.lastCreatedAt + 1,
							...(previous === null ? [] : [previous.createdAt.getTime() + 1]),
						),
					);
					clock.lastCreatedAt = createdAt.getTime();
					yield* query(
						db
							.insert(scheduledMerges)
							.values({
								owner: input.owner,
								repo: input.repo,
								number: input.number,
								repo_root: input.repoRoot,
								method: input.method,
								route: input.route,
								created_at: createdAt,
							})
							.onConflictDoUpdate({
								target: [
									scheduledMerges.owner,
									scheduledMerges.repo,
									scheduledMerges.number,
								],
								set: {
									repo_root: input.repoRoot,
									method: input.method,
									route: input.route,
									created_at: createdAt,
								},
							}),
					);
				});
			const remove = (key: ScheduledMergeKey) =>
				query(db.delete(scheduledMerges).where(whereKey(key)));
			return { list, get, put, delete: remove };
		}),
	},
) {
	static layer = Layer.effect(ScheduledMergeStore, ScheduledMergeStore.make);
}
