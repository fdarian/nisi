import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { DEFAULT_SETTINGS, SettingsStore } from "../src/store.ts";
import { makeTestLayer, withTempDataDir } from "./fixtures.ts";

const run = <A, E>(
	dataDir: string,
	effect: Effect.Effect<A, E, SettingsStore>,
) => Effect.runPromise(effect.pipe(Effect.provide(makeTestLayer(dataDir))));

describe("SettingsStore", () => {
	test("get() returns defaults before any update has been written", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					return yield* store.get();
				}),
			);
			expect(result).toEqual(DEFAULT_SETTINGS);
		});
	});

	test("get() reports enabledHarnesses as null (never configured), not an empty array", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					return yield* store.get();
				}),
			);
			expect(result.enabledHarnesses).toBeNull();
		});
	});

	test("update() distinguishes an empty deliberate choice from unset", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					yield* store.update({ enabledHarnesses: [] });
					return yield* store.get();
				}),
			);
			expect(result.enabledHarnesses).toEqual([]);
			expect(result.enabledHarnesses).not.toBeNull();
		});
	});

	test("update() can revert enabledHarnesses back to unset with an explicit null", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					yield* store.update({ enabledHarnesses: ["pi"] });
					yield* store.update({ enabledHarnesses: null });
					return yield* store.get();
				}),
			);
			expect(result.enabledHarnesses).toBeNull();
		});
	});

	test("update() round-trips through get()", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					yield* store.update({ enabledHarnesses: ["claude-code"] });
					return yield* store.get();
				}),
			);
			expect(result.enabledHarnesses).toEqual(["claude-code"]);
		});
	});

	test("update() returns the merged settings directly", async () => {
		await withTempDataDir(async (dataDir) => {
			const updated = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					return yield* store.update({ diffStyleMode: "split" });
				}),
			);
			expect(updated.diffStyleMode).toBe("split");
			expect(updated.enabledHarnesses).toEqual(
				DEFAULT_SETTINGS.enabledHarnesses,
			);
		});
	});

	test("a partial update doesn't clobber fields it didn't mention", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					yield* store.update({ enabledHarnesses: ["pi"] });
					yield* store.update({ sidebarViewMode: "flat" });
					return yield* store.get();
				}),
			);
			expect(result.enabledHarnesses).toEqual(["pi"]);
			expect(result.sidebarViewMode).toBe("flat");
			expect(result.diffStyleMode).toBe(DEFAULT_SETTINGS.diffStyleMode);
		});
	});

	test("successive updates apply against the same row instead of inserting a second one", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* SettingsStore;
					yield* store.update({ sidebarViewMode: "flat" });
					yield* store.update({ sidebarViewMode: "tree" });
					return yield* store.get();
				}),
			);
			expect(result.sidebarViewMode).toBe("tree");
		});
	});
});
