import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { ConfigProvider, Effect, Layer } from "effect";
import { ScheduledMergeStore } from "../src/scheduled-merge-store.ts";
import { withTempDataDir } from "./fixtures.ts";

const key = { owner: "fdarian", repo: "nisi", number: 122 };
const input = { ...key, repoRoot: "/repo", method: "squash" as const };
const run = <A, E>(
	dataDir: string,
	effect: Effect.Effect<A, E, ScheduledMergeStore>,
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(
				ScheduledMergeStore.layer.pipe(
					Layer.provideMerge(SqliteDb.layer),
					Layer.provideMerge(BunServices.layer),
					Layer.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
						),
					),
				),
			),
		),
	);

describe("ScheduledMergeStore", () => {
	test("empty, upsert, independent PR keys, and idempotent deletion", async () => {
		await withTempDataDir(async (dataDir) => {
			await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ScheduledMergeStore;
					expect(yield* store.get(key)).toBeNull();
					expect(yield* store.list()).toHaveLength(0);
					yield* store.put(input);
					const saved = yield* store.get(key);
					expect(saved?.method).toBe("squash");
					expect(saved?.createdAt).toBeInstanceOf(Date);
					yield* store.put({ ...input, method: "rebase", repoRoot: "/moved" });
					yield* store.put({ ...input, number: 123 });
					yield* store.put({ ...input, repo: "other" });
					yield* store.put({ ...input, owner: "other" });
					expect(yield* store.list()).toHaveLength(4);
					expect((yield* store.get(key))?.repoRoot).toBe("/moved");
					expect((yield* store.get(key))?.method).toBe("rebase");
					yield* store.delete(key);
					yield* store.delete(key);
					expect(yield* store.get(key)).toBeNull();
					expect(yield* store.list()).toHaveLength(3);
				}),
			);
		});
	});
	test("persists schedules across service restarts", async () => {
		await withTempDataDir(async (dataDir) => {
			await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ScheduledMergeStore;
					yield* store.put(input);
				}),
			);
			const saved = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ScheduledMergeStore;
					return yield* store.get(key);
				}),
			);
			expect(saved?.method).toBe("squash");
		});
	});
});
