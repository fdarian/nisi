import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option } from "effect";
import {
	findCachedIndex,
	listCachedIndexes,
	mostRecentCachedIndex,
	readIndexBytes,
	writeIndex,
} from "../src/cache.ts";

const withTempDataDir = async <T>(
	fn: (dataDir: string) => Promise<T>,
): Promise<T> => {
	const dir = await mkdtemp(join(tmpdir(), "nisi-code-index-cache-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const REPO_ROOT = "/Users/example/repo";

describe("code-index cache", () => {
	test("findCachedIndex is none for a repo never indexed", async () => {
		await withTempDataDir(async (dataDir) => {
			const found = await run(findCachedIndex(dataDir, REPO_ROOT, "abc123"));
			expect(Option.isNone(found)).toBe(true);
		});
	});

	test("writeIndex then findCachedIndex round-trips the exact head sha", async () => {
		await withTempDataDir(async (dataDir) => {
			const bytes = new Uint8Array([1, 2, 3, 4]);
			await run(writeIndex(dataDir, REPO_ROOT, "sha-a", bytes));

			const found = await run(findCachedIndex(dataDir, REPO_ROOT, "sha-a"));
			expect(Option.isSome(found)).toBe(true);
			if (Option.isNone(found)) throw new Error("unreachable");
			expect(found.value.headSha).toBe("sha-a");

			const readBack = await run(readIndexBytes(dataDir, REPO_ROOT, "sha-a"));
			expect([...readBack]).toEqual([1, 2, 3, 4]);
		});
	});

	test("findCachedIndex is none for a different head sha than what's cached", async () => {
		await withTempDataDir(async (dataDir) => {
			await run(writeIndex(dataDir, REPO_ROOT, "sha-a", new Uint8Array([1])));
			const found = await run(findCachedIndex(dataDir, REPO_ROOT, "sha-b"));
			expect(Option.isNone(found)).toBe(true);
		});
	});

	test("keeps only the 2 most recent index files per repo", async () => {
		await withTempDataDir(async (dataDir) => {
			// A small delay between writes so each file gets a distinct mtime —
			// otherwise same-millisecond writes would make "most recent" ambiguous.
			await run(writeIndex(dataDir, REPO_ROOT, "sha-1", new Uint8Array([1])));
			await new Promise((resolve) => setTimeout(resolve, 20));
			await run(writeIndex(dataDir, REPO_ROOT, "sha-2", new Uint8Array([2])));
			await new Promise((resolve) => setTimeout(resolve, 20));
			await run(writeIndex(dataDir, REPO_ROOT, "sha-3", new Uint8Array([3])));

			const remaining = await run(listCachedIndexes(dataDir, REPO_ROOT));
			expect(remaining.map((entry) => entry.headSha)).toEqual([
				"sha-3",
				"sha-2",
			]);

			const pruned = await run(findCachedIndex(dataDir, REPO_ROOT, "sha-1"));
			expect(Option.isNone(pruned)).toBe(true);
		});
	});

	test("mostRecentCachedIndex reports the newest regardless of which head sha it's for", async () => {
		await withTempDataDir(async (dataDir) => {
			await run(writeIndex(dataDir, REPO_ROOT, "sha-old", new Uint8Array([1])));
			await new Promise((resolve) => setTimeout(resolve, 20));
			await run(writeIndex(dataDir, REPO_ROOT, "sha-new", new Uint8Array([2])));

			const mostRecent = await run(mostRecentCachedIndex(dataDir, REPO_ROOT));
			expect(Option.isSome(mostRecent)).toBe(true);
			if (Option.isNone(mostRecent)) throw new Error("unreachable");
			expect(mostRecent.value.headSha).toBe("sha-new");
		});
	});

	test("two different repos never share a cache directory", async () => {
		await withTempDataDir(async (dataDir) => {
			await run(writeIndex(dataDir, "/repo/one", "sha-a", new Uint8Array([1])));
			await run(writeIndex(dataDir, "/repo/two", "sha-a", new Uint8Array([2])));

			const bytesOne = await run(readIndexBytes(dataDir, "/repo/one", "sha-a"));
			const bytesTwo = await run(readIndexBytes(dataDir, "/repo/two", "sha-a"));
			expect([...bytesOne]).toEqual([1]);
			expect([...bytesTwo]).toEqual([2]);
		});
	});
});
