import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { readBlobsAtRef } from "../src/blob.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("readBlobsAtRef", () => {
	test("reads content and size for an ordinary blob, without an ls-tree call", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello world\n");
			const base = await repo.commit("base");

			const blobs = await run(readBlobsAtRef(repo.root, base, ["a.ts"]));
			const entry = blobs.get("a.ts");
			expect(entry?.content).toBeDefined();
			expect(new TextDecoder().decode(entry?.content ?? new Uint8Array())).toBe(
				"hello world\n",
			);
			expect(entry?.size).toBe("hello world\n".length);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("omits a path that doesn't exist at the given ref", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "content\n");
			const base = await repo.commit("base");

			const blobs = await run(
				readBlobsAtRef(repo.root, base, ["does/not/exist.ts"]),
			);
			expect(blobs.has("does/not/exist.ts")).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("omits a submodule path (a gitlink tree entry, not a blob)", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("readme.md", "hello\n");
			await repo.commit("base");

			// Fabricates a gitlink entry the way a real submodule would leave one,
			// without needing an actual second repository — `update-index
			// --cacheinfo 160000,<sha>,<path>` records the tree entry directly.
			// Committed via a direct `git commit` (not the `TestRepo.commit`
			// helper's `add -A`), which would otherwise treat the gitlink's path
			// as a missing file and stage its removal instead.
			const fakeSubmoduleCommit = "1".repeat(40);
			await repo.git([
				"update-index",
				"--add",
				"--cacheinfo",
				`160000,${fakeSubmoduleCommit},vendor/lib`,
			]);
			await repo.git(["commit", "-q", "-m", "add submodule"]);
			const withSubmodule = (await repo.git(["rev-parse", "HEAD"])).trim();

			const blobs = await run(
				readBlobsAtRef(repo.root, withSubmodule, ["vendor/lib", "readme.md"]),
			);
			expect(blobs.has("vendor/lib")).toBe(false);
			expect(blobs.get("readme.md")?.content).toBeDefined();
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("reports size but withholds content past maxBytes", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("big.txt", "a".repeat(1000));
			const base = await repo.commit("base");

			const blobs = await run(
				readBlobsAtRef(repo.root, base, ["big.txt"], { maxBytes: 100 }),
			);
			const entry = blobs.get("big.txt");
			expect(entry?.size).toBe(1000);
			expect(entry?.content).toBeNull();
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("resolves every requested path in one batch, including duplicates", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "aaa\n");
			await repo.write("b.ts", "bbb\n");
			const base = await repo.commit("base");

			const blobs = await run(
				readBlobsAtRef(repo.root, base, ["a.ts", "b.ts", "a.ts"]),
			);
			expect(blobs.size).toBe(2);
			expect(
				new TextDecoder().decode(
					blobs.get("a.ts")?.content ?? new Uint8Array(),
				),
			).toBe("aaa\n");
			expect(
				new TextDecoder().decode(
					blobs.get("b.ts")?.content ?? new Uint8Array(),
				),
			).toBe("bbb\n");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns an empty map for an empty path list", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "content\n");
			const base = await repo.commit("base");

			const blobs = await run(readBlobsAtRef(repo.root, base, []));
			expect(blobs.size).toBe(0);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
