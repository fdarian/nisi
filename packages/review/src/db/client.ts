import { Database as SqliteDatabase } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import migrationBundle from "../../.gen/migrations.gen.ts";
import { ReviewStoreError } from "../errors.ts";
import { applyEmbeddedMigrations } from "./apply-migrations.ts";
import * as schema from "./schema.ts";

export type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

export const runMigrations = (db: DrizzleClient) =>
	applyEmbeddedMigrations(db, migrationBundle).pipe(
		Effect.mapError((cause) => new ReviewStoreError({ cause })),
	);

export const openReviewDb = (dbPath: string) =>
	Effect.acquireRelease(
		Effect.try({
			try: () => {
				const connection = new SqliteDatabase(dbPath, { create: true });
				connection.exec("PRAGMA foreign_keys = ON");
				return connection;
			},
			catch: (cause) => new ReviewStoreError({ cause }),
		}),
		(sqliteConnection) =>
			Effect.sync(() => {
				sqliteConnection.close();
			}),
	);

export const initDrizzle = (sqlite: SqliteDatabase) =>
	Effect.try({
		try: () => drizzle(sqlite, { schema }),
		catch: (cause) => new ReviewStoreError({ cause }),
	});

export const dbUse = <T>(db: DrizzleClient, fn: (client: DrizzleClient) => T) =>
	Effect.try({
		try: () => fn(db),
		catch: (cause) => new ReviewStoreError({ cause }),
	});
