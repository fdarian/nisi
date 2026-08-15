import { layerSqliteClient } from "deskkit/sqlite";
import * as SqliteDrizzle from "drizzle-orm/effect-sqlite-bun";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { getAppDbPath, getDataDirConfig } from "./paths.ts";

/**
 * A `SqliteClient` for the app's one db file, with the data dir created
 * first — `SqliteClient.make`'s underlying `bun:sqlite` connection won't
 * create missing parent directories itself. Kept private: nothing
 * downstream of `SqliteDb.layer` needs `SqliteClient` in context, only the
 * drizzle client `SqliteDb` wraps it into.
 */
const layerAppSqliteClient = Layer.unwrap(
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		yield* fs.makeDirectory(dataDir, { recursive: true });
		return layerSqliteClient({ filename: getAppDbPath(dataDir) });
	}),
);

/**
 * The app's one SQLite connection + Drizzle client, shared by every domain
 * package's store (`@repo/review`'s `ReviewStore`, the sidecar's
 * `WalkthroughStore`, …) — see this package's AGENTS.md for why there's one
 * file instead of one per domain. Every domain still owns its own tables
 * and its own generated migration bundle, applied against this same
 * connection via `deskkit/sqlite`'s `applyEmbeddedMigrations` rather than
 * anything re-exported from here.
 *
 * `yield* SqliteDb` returns the drizzle db directly — call sites read
 * `const db = yield* SqliteDb; const rows = yield* db.select()...`, since
 * drizzle's Effect integration already returns query results as `Effect`s
 * needing no wrapper of our own.
 *
 * `deskkit`'s `layerSqliteClient` sets `PRAGMA foreign_keys = ON`;
 * `@effect/sql-sqlite-bun`'s `SqliteClient.make`, which it wraps, already
 * defaults to a 5-second `busy_timeout` and WAL journal mode on its own —
 * see `test/client.test.ts`'s regression test for why those two matter
 * here specifically (two connections racing a fresh file's first `CREATE
 * TABLE`).
 *
 * Needs `FileSystem` in context wherever `SqliteDb.layer` is composed (see
 * `layerAppSqliteClient` above).
 */
export class SqliteDb extends Context.Service<SqliteDb>()("SqliteDb", {
	make: SqliteDrizzle.make(),
}) {
	/**
	 * `SqliteDrizzle.DefaultServices` and `layerAppSqliteClient` are provided
	 * internally, not merged into the exported layer — nothing downstream
	 * should learn that drizzle needs `SqliteClient`, `EffectCache`, or
	 * `EffectLogger` in context.
	 */
	static readonly layer = Layer.effect(SqliteDb, SqliteDb.make).pipe(
		Layer.provide(SqliteDrizzle.DefaultServices),
		Layer.provide(layerAppSqliteClient),
	);
}

/** The shape `yield* SqliteDb` resolves to — domain packages use this to type their own `runMigrations(db: DrizzleClient)` helpers without importing the drizzle adapter directly. */
export type DrizzleClient = Context.Service.Shape<typeof SqliteDb>;
