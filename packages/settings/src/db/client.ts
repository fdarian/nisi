import type { DrizzleClient } from "@repo/db";
import { applyEmbeddedMigrations } from "deskkit/sqlite";
import { Effect } from "effect";
import migrationBundle from "../../.gen/migrations.gen.ts";
import { SettingsStoreError } from "../errors.ts";

/**
 * Applies this package's own embedded migration bundle to the shared
 * `SqliteDb` connection, tracked in its own `migrationsTable` — see
 * `@repo/db`'s AGENTS.md for why that can't be the default shared table name
 * once more than one domain's migrations exist.
 */
export const runMigrations = (db: DrizzleClient) =>
	applyEmbeddedMigrations(
		db,
		migrationBundle,
		"__drizzle_migrations_settings",
	).pipe(Effect.mapError((cause) => new SettingsStoreError({ cause })));
