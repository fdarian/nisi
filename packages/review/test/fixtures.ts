import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Layer } from "effect";
import { ReviewStore } from "../src/store.ts";

/**
 * A `ReviewStore` layer pointed at an isolated temp data dir via its own
 * `ConfigProvider`, rather than mutating `process.env.NISI_DATA_DIR` — bun
 * test doesn't strictly serialize independent `test()` bodies, so a shared
 * global would let concurrently-running tests read each other's data dir.
 *
 * `provideMerge`, not `provide`, for `BunServices` — `markFileViewed` shells
 * out to `writeBlob`'s own `yield* FileSystem`, so `FileSystem` needs to stay
 * available to the caller's effect, not just be consumed while constructing
 * the `ReviewStore` service itself.
 */
export const makeTestLayer = (dataDir: string) =>
	ReviewStore.layer.pipe(
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
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-review-test-"));
	try {
		return await fn(dataDir);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
};
