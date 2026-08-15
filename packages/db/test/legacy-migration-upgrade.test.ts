import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { applyEmbeddedMigrations } from "deskkit/sqlite";
import { ConfigProvider, Effect, Layer } from "effect";
import { SqliteDb } from "../src/client.ts";

/**
 * Mirrors deskkit's own `folderMillisFromName` (`deskkit/src/sqlite/migrations.ts`)
 * — the `YYYYMMDDHHMMSS` timestamp prefix every drizzle-kit 1.x migration
 * folder name carries, parsed the same way drizzle's `upgradeIfNeeded`
 * matches a legacy bookkeeping row's `created_at` against a local
 * migration's `folderMillis`.
 */
const folderMillisFromName = (name: string): number => {
	const timestamp = name.slice(0, 14);
	const year = Number(timestamp.slice(0, 4));
	const month = Number(timestamp.slice(4, 6)) - 1;
	const day = Number(timestamp.slice(6, 8));
	const hour = Number(timestamp.slice(8, 10));
	const minute = Number(timestamp.slice(10, 12));
	const second = Number(timestamp.slice(12, 14));
	return Date.UTC(year, month, day, hour, minute, second);
};

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

/**
 * The two migrations this test's fake legacy install already had applied,
 * before the drizzle-kit v1 folder-layout conversion (Phase 1) renamed every
 * migration folder from a flat `NNNN_words` index to a
 * `YYYYMMDDHHMMSS_words` timestamp. Their SQL text — and therefore their
 * sha256 hash — is untouched by that rename, only the folder name is; this
 * is what lets `drizzle-orm`'s legacy-table upgrade resolve an old row back
 * to the right migration by matching `created_at` (and, on a collision,
 * hash) against a migration whose *name* looks nothing like what was
 * recorded at generation time.
 *
 * No `IF NOT EXISTS` on the `CREATE TABLE` — if the upgrade path ever
 * mistakes this "already applied" row for a pending one and replays its SQL
 * against a database that already has the table, SQLite throws
 * `table already exists` and this test fails loudly instead of silently
 * passing.
 */
const legacyMigrations = [
	{
		name: "20260101000000_alpha",
		sql: "CREATE TABLE alpha (id INTEGER PRIMARY KEY, val TEXT);",
	},
	{
		name: "20260102000000_beta",
		sql: "CREATE TABLE beta (id INTEGER PRIMARY KEY, val TEXT);",
	},
];

const migrationsTable = "__drizzle_migrations_legacy_test";

/**
 * Builds a v0-shaped `app.db` by hand — the exact schema
 * `drizzle-orm@0.45.2`'s `SQLiteSyncDialect.migrate` created
 * (`sqlite-core/dialect.js`: `id SERIAL PRIMARY KEY, hash text NOT NULL,
 * created_at numeric`, no `name`/`applied_at` columns), with both
 * `legacyMigrations` already recorded as applied and their `CREATE TABLE`s
 * already run — standing in for a real pre-Phase-1 install rather than a
 * checked-in binary fixture. Also seeds a real row into `alpha` so a data
 * loss regression would show up as a failed assertion, not a silently empty
 * table.
 */
const seedLegacyDb = (dbPath: string) => {
	const raw = new Database(dbPath, { create: true });
	raw.exec(`
		CREATE TABLE ${migrationsTable} (
			id SERIAL PRIMARY KEY,
			hash text NOT NULL,
			created_at numeric
		)
	`);
	for (const migration of legacyMigrations) {
		raw.exec(migration.sql);
		raw
			.query(`INSERT INTO ${migrationsTable} (hash, created_at) VALUES (?, ?)`)
			.run(sha256(migration.sql), folderMillisFromName(migration.name));
	}
	raw
		.query("INSERT INTO alpha (val) VALUES (?)")
		.run("pre-existing legacy row");
	raw.close();
};

const layerFor = (dataDir: string) =>
	SqliteDb.layer.pipe(
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

describe("legacy migrations-table upgrade", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "nisi-legacy-migration-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("upgrades a v0-shaped bookkeeping table without re-running migrations or losing data", async () => {
		seedLegacyDb(join(dataDir, "app.db"));

		await Effect.runPromise(
			Effect.gen(function* () {
				const db = yield* SqliteDb;
				yield* applyEmbeddedMigrations(
					db,
					{ migrations: legacyMigrations },
					migrationsTable,
				);
			}).pipe(Effect.provide(layerFor(dataDir))),
		);

		const raw = new Database(join(dataDir, "app.db"), { readonly: true });

		const columns = raw
			.query(`PRAGMA table_info(${migrationsTable})`)
			.all() as Array<{ name: string }>;
		expect(columns.map((c) => c.name)).toEqual([
			"id",
			"hash",
			"created_at",
			"name",
			"applied_at",
		]);

		const rows = raw
			.query(
				`SELECT hash, name, applied_at FROM ${migrationsTable} ORDER BY created_at ASC`,
			)
			.all() as Array<{
			hash: string;
			name: string | null;
			applied_at: string | null;
		}>;
		expect(rows).toEqual([
			{
				hash: sha256(legacyMigrations[0]?.sql ?? ""),
				name: "20260101000000_alpha",
				applied_at: null,
			},
			{
				hash: sha256(legacyMigrations[1]?.sql ?? ""),
				name: "20260102000000_beta",
				applied_at: null,
			},
		]);

		// The pre-existing row survived, and no migration re-ran a second
		// insert into `alpha` — exactly one row, exactly the original value.
		const alphaRows = raw.query("SELECT val FROM alpha").all();
		expect(alphaRows).toEqual([{ val: "pre-existing legacy row" }]);

		raw.close();
	});
});
