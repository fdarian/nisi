import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { RepoMergeMethodStore } from "../src/repo-merge-method-store.ts";
import { makeRepoMergeMethodTestLayer, withTempDataDir } from "./fixtures.ts";

const run = <A, E>(
	dataDir: string,
	effect: Effect.Effect<A, E, RepoMergeMethodStore>,
) =>
	Effect.runPromise(
		effect.pipe(Effect.provide(makeRepoMergeMethodTestLayer(dataDir))),
	);

describe("RepoMergeMethodStore", () => {
	test("get() returns null before anything's been recorded", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* RepoMergeMethodStore;
					return yield* store.get("fdarian", "nisi");
				}),
			);
			expect(result).toBeNull();
		});
	});

	test("set() round-trips through get()", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* RepoMergeMethodStore;
					yield* store.set("fdarian", "nisi", "squash");
					return yield* store.get("fdarian", "nisi");
				}),
			);
			expect(result).toBe("squash");
		});
	});

	test("set() overwrites the same owner/repo's row instead of inserting a second one", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* RepoMergeMethodStore;
					yield* store.set("fdarian", "nisi", "merge");
					yield* store.set("fdarian", "nisi", "rebase");
					return yield* store.get("fdarian", "nisi");
				}),
			);
			expect(result).toBe("rebase");
		});
	});

	test("different repos under the same owner get independent methods", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* RepoMergeMethodStore;
					yield* store.set("fdarian", "nisi", "squash");
					yield* store.set("fdarian", "whap", "rebase");
					const nisi = yield* store.get("fdarian", "nisi");
					const whap = yield* store.get("fdarian", "whap");
					return { nisi, whap };
				}),
			);
			expect(result.nisi).toBe("squash");
			expect(result.whap).toBe("rebase");
		});
	});
});
