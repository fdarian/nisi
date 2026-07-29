import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { ConfigProvider, Layer } from "effect";
import { SettingsStore } from "../src/store.ts";

/**
 * A `SettingsStore` layer pointed at an isolated temp data dir via its own
 * `ConfigProvider`, rather than mutating `process.env.NISI_DATA_DIR` — bun
 * test doesn't strictly serialize independent `test()` bodies, so a shared
 * global would let concurrently-running tests read each other's data dir.
 * Same pattern as `@repo/review`'s `test/fixtures.ts`. `BunServices.layer` is
 * still needed even though `SettingsStore` itself does no filesystem I/O
 * directly — `SqliteDb.make` needs `FileSystem` to create the data dir.
 */
export const makeTestLayer = (dataDir: string) =>
	SettingsStore.layer.pipe(
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

export const withTempDataDir = async <T>(
	fn: (dataDir: string) => Promise<T>,
): Promise<T> => {
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-settings-test-"));
	try {
		return await fn(dataDir);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
};
