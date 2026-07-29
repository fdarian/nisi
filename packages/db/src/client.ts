import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Context, Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { DbError } from "./errors.ts";
import { getAppDbPath, getDataDirConfig } from "./paths.ts";

export type DrizzleClient = ReturnType<typeof drizzle>;

const openConnection = (dbPath: string) =>
	Effect.acquireRelease(
		Effect.try({
			try: () => {
				const connection = new Database(dbPath, { create: true });
				connection.exec("PRAGMA foreign_keys = ON");
				// Two processes opening this file at once is a real scenario, not
				// a hypothetical one — it's what let two cold sidecar boots
				// collide on Drizzle's `CREATE TABLE IF NOT EXISTS` migration
				// step before the sidecar's own boot-time lock (see
				// `apps/desktop/sidecar/sidecar-lock.ts`) started gating DB
				// construction, and the lock only protects sidecar-vs-sidecar —
				// a stray debug script or a future reader opening `app.db`
				// directly gets none of that. `busy_timeout` makes a second
				// opener wait out the first's transaction instead of failing
				// immediately with `SQLITE_BUSY`.
				connection.exec("PRAGMA busy_timeout = 5000");
				// WAL goes further: readers no longer block on a writer (or
				// vice versa) at all, which is the right default here — this is
				// a local desktop app with a genuinely concurrent access
				// pattern even in the common case (request handlers reading
				// while a write lands, the live-poll background fiber's own
				// reads), not just the rare-contention case `busy_timeout`
				// alone covers.
				connection.exec("PRAGMA journal_mode = WAL");
				return connection;
			},
			catch: (cause) => new DbError({ cause }),
		}),
		(connection) => Effect.sync(() => connection.close()),
	);

const buildDrizzle = (sqlite: Database) =>
	Effect.try({
		try: () => drizzle(sqlite),
		catch: (cause) => new DbError({ cause }),
	});

/**
 * The app's one SQLite connection + Drizzle client, shared by every domain
 * package's store (`@repo/review`'s `ReviewStore`, the sidecar's
 * `WalkthroughStore`, …). One instance for the whole sidecar process — each
 * domain still owns its own tables and its own generated migration bundle,
 * but they're applied against this same connection rather than each domain
 * opening its own file. See this package's AGENTS.md for the reasoning.
 */
export class SqliteDb extends Context.Service<SqliteDb>()("SqliteDb", {
	make: Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		yield* fs
			.makeDirectory(dataDir, { recursive: true })
			.pipe(Effect.mapError((cause) => new DbError({ cause })));

		const dbPath = getAppDbPath(dataDir);
		const sqlite = yield* openConnection(dbPath);
		const db = yield* buildDrizzle(sqlite);
		return { sqlite, db };
	}),
}) {
	static layer = Layer.effect(SqliteDb, SqliteDb.make);
}

/** Runs a Drizzle query, wrapping a thrown error as `DbError` instead of letting it escape untyped. */
export const dbUse = <T>(
	db: DrizzleClient,
	fn: (client: DrizzleClient) => T,
): Effect.Effect<T, DbError> =>
	Effect.try({ try: () => fn(db), catch: (cause) => new DbError({ cause }) });
