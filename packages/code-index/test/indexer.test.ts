import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { detectTsConfigPresence } from "../src/indexer.ts";

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
	const dir = await mkdtemp(join(tmpdir(), "nisi-code-index-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

const runDetect = (repoRoot: string) =>
	Effect.runPromise(
		detectTsConfigPresence(repoRoot).pipe(Effect.provide(BunServices.layer)),
	);

describe("detectTsConfigPresence", () => {
	test("false for a repo with no tsconfig anywhere", async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "README.md"), "hello");
			expect(await runDetect(dir)).toBe(false);
		});
	});

	test("true for a tsconfig.json at the repo root", async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "tsconfig.json"), "{}");
			expect(await runDetect(dir)).toBe(true);
		});
	});

	test("true for a variant name (tsconfig.base.json) nested under a project directory", async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, "packages", "app"), { recursive: true });
			await writeFile(join(dir, "packages", "app", "tsconfig.base.json"), "{}");
			expect(await runDetect(dir)).toBe(true);
		});
	});

	test("ignores a tsconfig.json buried inside node_modules", async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, "node_modules", "some-dep"), { recursive: true });
			await writeFile(
				join(dir, "node_modules", "some-dep", "tsconfig.json"),
				"{}",
			);
			expect(await runDetect(dir)).toBe(false);
		});
	});
});
