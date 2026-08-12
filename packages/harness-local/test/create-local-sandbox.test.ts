import { describe, expect, test } from "bun:test";
import { lstat, readlink, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createLocalSandbox } from "../src/local-sandbox-provider.ts";
import { cleanupTempDir, makeTempDir } from "./fixtures.ts";

describe("createLocalSandbox", () => {
	test("in-place mode roots the provider at the repo's parent and uses the repo's own folder name as workDir", async () => {
		const repoRoot = await makeTempDir();
		try {
			const sandbox = createLocalSandbox({ mode: "in-place", repoRoot });
			expect(sandbox.workDir).toBe(basename(repoRoot));

			const session = await sandbox.provider.createSession();
			try {
				expect(session.defaultWorkingDirectory).toBe(dirname(repoRoot));
			} finally {
				await session.stop();
			}
		} finally {
			await cleanupTempDir(repoRoot);
		}
	});

	test("relocated mode roots the provider at the scratch root and symlinks workDir to the repo", async () => {
		const repoRoot = await makeTempDir();
		const scratchRoot = await makeTempDir();
		try {
			await writeFile(join(repoRoot, "marker.txt"), "hi");

			const sandbox = createLocalSandbox({
				mode: "relocated",
				repoRoot,
				scratchRoot,
			});
			expect(sandbox.workDir).not.toBe(basename(repoRoot));
			expect(sandbox.workDir.endsWith(`-${basename(repoRoot)}`)).toBe(true);

			const session = await sandbox.provider.createSession();
			try {
				expect(session.defaultWorkingDirectory).toBe(scratchRoot);

				const linkPath = join(scratchRoot, sandbox.workDir);
				const stat = await lstat(linkPath);
				expect(stat.isSymbolicLink()).toBe(true);
				expect(await readlink(linkPath)).toBe(repoRoot);

				// The symlink actually reaches the real repo's contents.
				expect(
					await session.readTextFile({
						path: join(sandbox.workDir, "marker.txt"),
					}),
				).toBe("hi");
			} finally {
				await session.stop();
			}
		} finally {
			await cleanupTempDir(repoRoot);
			await cleanupTempDir(scratchRoot);
		}
	});

	test("relocated mode is idempotent across repeated sessions against the same repo", async () => {
		const repoRoot = await makeTempDir();
		const scratchRoot = await makeTempDir();
		try {
			const sandbox = createLocalSandbox({
				mode: "relocated",
				repoRoot,
				scratchRoot,
			});

			const first = await sandbox.provider.createSession();
			await first.stop();
			const second = await sandbox.provider.createSession();
			await second.stop();

			const linkPath = join(scratchRoot, sandbox.workDir);
			expect(await readlink(linkPath)).toBe(repoRoot);
		} finally {
			await cleanupTempDir(repoRoot);
			await cleanupTempDir(scratchRoot);
		}
	});

	test("relocated mode replaces a symlink that points at a stale repo location", async () => {
		const repoRoot = await makeTempDir();
		const staleTarget = await makeTempDir();
		const scratchRoot = await makeTempDir();
		try {
			const sandbox = createLocalSandbox({
				mode: "relocated",
				repoRoot,
				scratchRoot,
			});
			const linkPath = join(scratchRoot, sandbox.workDir);
			await symlink(staleTarget, linkPath);

			const session = await sandbox.provider.createSession();
			try {
				expect(await readlink(linkPath)).toBe(repoRoot);
			} finally {
				await session.stop();
			}
		} finally {
			await cleanupTempDir(repoRoot);
			await cleanupTempDir(staleTarget);
			await cleanupTempDir(scratchRoot);
		}
	});
});
