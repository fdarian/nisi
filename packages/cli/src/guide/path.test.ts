import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "../index.ts");
const dirs: string[] = [];

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const temp = async (prefix: string) => {
	const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};

const git = (cwd: string, ...args: string[]) =>
	Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
		cwd,
	});

const repoOnBranch = async (branch: string) => {
	const repo = await temp("nisi-path-repo-");
	git(repo, "init", "-q", "-b", branch);
	git(repo, "commit", "-q", "--allow-empty", "-m", "init");
	return repo;
};

const guidePath = (cwd: string, dataDir: string) => {
	const result = Bun.spawnSync([process.execPath, entry, "guide", "path"], {
		cwd,
		env: { ...process.env, NISI_DATA_DIR: dataDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
};

test("prints only the folder on stdout and creates it", async () => {
	const dataDir = await temp("nisi-path-data-");
	const repo = await repoOnBranch("feature/guide");
	const result = guidePath(repo, dataDir);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toMatch(
		new RegExp(`^${dataDir}/guides/local/[0-9a-f]{16}/feature%2Fguide\\n$`),
	);
	expect(result.stderr).toBe("");
	expect((await stat(result.stdout.trim())).isDirectory()).toBe(true);
	expect(await Bun.file(join(repo, ".nisi")).exists()).toBe(false);
});

test("a guide left in the worktree is pointed out on stderr, stdout stays the path", async () => {
	const dataDir = await temp("nisi-path-data-");
	const repo = await repoOnBranch("main");
	await mkdir(join(repo, ".nisi/guide"), { recursive: true });
	await writeFile(join(repo, ".nisi/guide/guide.mdx"), "## Overview\n");
	const result = guidePath(repo, dataDir);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toMatch(new RegExp(`^${dataDir}/guides/.+/main\\n$`));
	expect(result.stderr).toContain(join(repo, ".nisi/guide"));
	expect(result.stderr).toContain(result.stdout.trim());
});

test("a detached HEAD with no origin fails with the reason, not a stack trace", async () => {
	const dataDir = await temp("nisi-path-data-");
	const repo = await repoOnBranch("main");
	git(repo, "checkout", "-q", "--detach");
	const result = guidePath(repo, dataDir);
	expect(result.exitCode).not.toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("HEAD is detached");
	expect(result.stderr).not.toContain("    at ");
});
