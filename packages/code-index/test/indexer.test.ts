import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { detectTsConfigPresence, resolveWorkspaceArgs } from "../src/indexer.ts";

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

const runWorkspaceArgs = (repoRoot: string) =>
	Effect.runPromise(
		resolveWorkspaceArgs(repoRoot).pipe(Effect.provide(BunServices.layer)),
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

/**
 * Regression tests for the bug found against a real bun workspace
 * (furl: bun.lock, root package.json "workspaces" field, no
 * pnpm-workspace.yaml, no root tsconfig.json, real tsconfigs at
 * apps/cli/tsconfig.json, apps/docs/tsconfig.json, packages/core/tsconfig.json).
 * detectTsConfigPresence correctly reported "supported" (a tsconfig exists
 * somewhere), but the old two-shape detection (pnpm workspace, or nothing)
 * fell through to a plain invocation at the repo root, which has no
 * tsconfig.json of its own — scip-typescript failed outright. Verified live
 * against the real furl repo (read-only, output to a scratch dir) that
 * --yarn-workspaces is not a viable alternative: it shells out to a real
 * `yarn workspaces list`/`info`, which fails with "yarn: command not found"
 * on a machine without yarn installed — the common case for a bun/npm repo.
 * Also verified live that passing every discovered project directory as
 * explicit positional arguments in one invocation works: scip-typescript
 * rebases every document's relativePath onto the single --cwd itself, not
 * each project's own root, so this needs no manual multi-index merging.
 */
describe("resolveWorkspaceArgs", () => {
	test("a pnpm workspace uses --pnpm-workspaces, no filesystem walk for projects", async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
			expect(await runWorkspaceArgs(dir)).toEqual(["--pnpm-workspaces"]);
		});
	});

	test("a plain single-project repo (root tsconfig.json, no workspace file) resolves to '.'", async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "tsconfig.json"), "{}");
			expect(await runWorkspaceArgs(dir)).toEqual(["."]);
		});
	});

	test("a bun/npm/yarn-style workspace (tsconfigs in subdirectories, no root tsconfig, no pnpm-workspace.yaml) lists every project directory", async () => {
		await withTempDir(async (dir) => {
			await writeFile(
				join(dir, "package.json"),
				JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
			);
			await mkdir(join(dir, "apps", "cli"), { recursive: true });
			await writeFile(join(dir, "apps", "cli", "tsconfig.json"), "{}");
			await mkdir(join(dir, "apps", "docs"), { recursive: true });
			await writeFile(join(dir, "apps", "docs", "tsconfig.json"), "{}");
			await mkdir(join(dir, "packages", "core"), { recursive: true });
			await writeFile(join(dir, "packages", "core", "tsconfig.json"), "{}");

			const args = await runWorkspaceArgs(dir);
			expect(new Set(args)).toEqual(
				new Set(["apps/cli", "apps/docs", "packages/core"]),
			);
			expect(args).toHaveLength(3);
		});
	});

	test("a shared base (tsconfig-library.json) is never listed as its own project", async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, "packages", "config"), { recursive: true });
			await writeFile(
				join(dir, "packages", "config", "tsconfig-library.json"),
				"{}",
			);
			await mkdir(join(dir, "packages", "core"), { recursive: true });
			await writeFile(join(dir, "packages", "core", "tsconfig.json"), "{}");

			expect(await runWorkspaceArgs(dir)).toEqual(["packages/core"]);
		});
	});

	test("a nested project under an already-found project is still listed (scip-typescript's own de-dup makes this safe)", async () => {
		await withTempDir(async (dir) => {
			await mkdir(join(dir, "packages", "foo", "tools"), { recursive: true });
			await writeFile(join(dir, "packages", "foo", "tsconfig.json"), "{}");
			await writeFile(
				join(dir, "packages", "foo", "tools", "tsconfig.json"),
				"{}",
			);

			const args = await runWorkspaceArgs(dir);
			expect(new Set(args)).toEqual(
				new Set(["packages/foo", "packages/foo/tools"]),
			);
		});
	});

	test("ignores a tsconfig.json buried inside node_modules", async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "tsconfig.json"), "{}");
			await mkdir(join(dir, "node_modules", "some-dep"), { recursive: true });
			await writeFile(
				join(dir, "node_modules", "some-dep", "tsconfig.json"),
				"{}",
			);

			expect(await runWorkspaceArgs(dir)).toEqual(["."]);
		});
	});

	test("no projects anywhere resolves to an empty list", async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, "README.md"), "hello");
			expect(await runWorkspaceArgs(dir)).toEqual([]);
		});
	});
});
