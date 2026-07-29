import {
	applyEmbeddedMigrations,
	type DrizzleClient,
	dbUse as dbUseShared,
} from "@repo/db";
import { Effect } from "effect";
import migrationBundle from "../../.gen/migrations.gen.ts";
import { SettingsStoreError } from "../errors.ts";

export type { DrizzleClient };

/**
 * Applies this package's own embedded migration bundle to the shared
 * `SqliteDb` connection, tracked in its own `migrationsTable` — see
 * `@repo/db`'s `applyEmbeddedMigrations` for why that can't be the default
 * shared table name once more than one domain's migrations exist.
 */
export const runMigrations = (db: DrizzleClient) =>
	applyEmbeddedMigrations(
		db,
		migrationBundle,
		"__drizzle_migrations_settings",
	).pipe(Effect.mapError((cause) => new SettingsStoreError({ cause })));

/** `@repo/db`'s `dbUse`, re-mapped to this package's own error type. */
export const dbUse = <T>(db: DrizzleClient, fn: (client: DrizzleClient) => T) =>
	dbUseShared(db, fn).pipe(
		Effect.mapError((cause) => new SettingsStoreError({ cause })),
	);
