import {
	applyEmbeddedMigrations,
	type DrizzleClient,
	dbUse as dbUseShared,
} from "@repo/db";
import { Effect } from "effect";
import migrationBundle from "../../.gen/migrations.gen.ts";
import { ReviewStoreError } from "../errors.ts";

export type { DrizzleClient };

/** Applies this package's own embedded migration bundle to the shared `SqliteDb` connection. */
export const runMigrations = (db: DrizzleClient) =>
	applyEmbeddedMigrations(db, migrationBundle).pipe(
		Effect.mapError((cause) => new ReviewStoreError({ cause })),
	);

/** `@repo/db`'s `dbUse`, re-mapped to this package's own error type. */
export const dbUse = <T>(db: DrizzleClient, fn: (client: DrizzleClient) => T) =>
	dbUseShared(db, fn).pipe(
		Effect.mapError((cause) => new ReviewStoreError({ cause })),
	);
