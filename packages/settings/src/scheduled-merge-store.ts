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
	readonly createdAt: Date;
};

const StoredMethod = Schema.Literals(["merge", "squash", "rebase"]);
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
				query(Schema.decodeUnknownEffect(StoredMethod)(row.method)).pipe(
					Effect.map(
						(method): ScheduledMerge => ({
							owner: row.owner,
							repo: row.repo,
							number: row.number,
							repoRoot: row.repo_root,
							method,
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
			const put = (input: Omit<ScheduledMerge, "createdAt">) => {
				const createdAt = new Date();
				return query(
					db
						.insert(scheduledMerges)
						.values({
							owner: input.owner,
							repo: input.repo,
							number: input.number,
							repo_root: input.repoRoot,
							method: input.method,
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
								created_at: createdAt,
							},
						}),
				);
			};
			const remove = (key: ScheduledMergeKey) =>
				query(db.delete(scheduledMerges).where(whereKey(key)));
			return { list, get, put, delete: remove };
		}),
	},
) {
	static layer = Layer.effect(ScheduledMergeStore, ScheduledMergeStore.make);
}
