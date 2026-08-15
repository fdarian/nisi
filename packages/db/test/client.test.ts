import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqliteDb } from "../src/client.ts";

const layerFor = (dataDir: string) =>
	SqliteDb.layer.pipe(
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

describe("SqliteDb", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "nisi-db-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("opens with WAL journal mode and a non-zero busy_timeout", async () => {
		const pragmas = await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* SqliteDb;
				const journalMode = yield* db.get<{ journal_mode: string }>(
					"PRAGMA journal_mode",
				);
				const busyTimeout = yield* db.get<{ timeout: number }>(
					"PRAGMA busy_timeout",
				);
				return {
					journalMode: journalMode.journal_mode,
					busyTimeout: busyTimeout.timeout,
				};
			}).pipe(Effect.provide(layerFor(dataDir))),
		);

		expect(pragmas.journalMode).toBe("wal");
		expect(pragmas.busyTimeout).toBeGreaterThan(0);
	});

	/**
	 * Regression test for the exact failure `busy_timeout` fixes: two
	 * connections opening the same fresh file and immediately issuing a
	 * `CREATE TABLE IF NOT EXISTS` (the shape Drizzle's migration step
	 * uses) — this used to throw `SQLITE_BUSY: database is locked`
	 * immediately for whichever connection lost the race, instead of
	 * waiting the other one out. Two `SqliteDb.layer` builds in this one
	 * process (each opening its own `bun:sqlite` connection to the same
	 * path) reproduce the same locking condition two separate sidecar
	 * processes did.
	 */
	test("two connections opening the same fresh file concurrently don't throw SQLITE_BUSY", async () => {
		const write = (table: string) =>
			Effect.gen(function* () {
				const db = yield* SqliteDb;
				yield* db.run(
					`CREATE TABLE IF NOT EXISTS ${table} (id INTEGER PRIMARY KEY)`,
				);
			}).pipe(Effect.provide(layerFor(dataDir)));

		await Promise.all([
			Effect.runPromise(write("a")),
			Effect.runPromise(write("b")),
		]);
	});
});
