import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuide, readableGuideDir, writeValidatedSha } from "./build.ts";

const dirs: string[] = [];

async function scratch(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nisi-guide-build-"));
	dirs.push(dir);
	return dir;
}

async function guideIn(dir: string, body: string) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "guide.mdx"), body);
}

async function gitRepo(): Promise<string> {
	const dir = await scratch();
	for (const args of [
		["init", "-q"],
		["commit", "-q", "--allow-empty", "-m", "i"],
	]) {
		const proc = Bun.spawn(
			["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
			{ cwd: dir, stdout: "ignore", stderr: "inherit" },
		);
		expect(await proc.exited).toBe(0);
	}
	return dir;
}

afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

test("the central folder wins over a legacy guide in the checkout", async () => {
	const repo = await scratch();
	const central = join(await scratch(), "owner/repo/feature");
	await guideIn(join(repo, ".nisi/guide"), "# legacy\n");
	await guideIn(central, "# central\n");
	expect(await readableGuideDir(central, repo)).toBe(central);
});

test("a legacy guide is read while the central folder has none", async () => {
	const repo = await scratch();
	const central = join(await scratch(), "owner/repo/feature");
	await guideIn(join(repo, ".nisi/guide"), "# legacy\n");
	expect(await readableGuideDir(central, repo)).toBe(join(repo, ".nisi/guide"));

	// A central folder that exists but holds no guide.mdx doesn't shadow it.
	await mkdir(central, { recursive: true });
	expect(await readableGuideDir(central, repo)).toBe(join(repo, ".nisi/guide"));
});

test("with no guide anywhere the central folder is reported, so the result says where to write", async () => {
	const repo = await scratch();
	const central = join(await scratch(), "owner/repo/feature");
	expect(await readableGuideDir(central, repo)).toBe(central);
});

test("a detached branch session reads the legacy folder only", async () => {
	const repo = await scratch();
	expect(await readableGuideDir(null, repo)).toBe(join(repo, ".nisi/guide"));
});

test("meta.json is reported as validatedSha, and stamping leaves the version alone", async () => {
	const repo = await gitRepo();
	const guideDir = join(await scratch(), "owner/repo/feature");
	await guideIn(guideDir, "# hi\n");

	const before = await buildGuide(guideDir, repo);
	if (before.kind !== "ok") throw new Error(JSON.stringify(before));
	expect(before.validatedSha).toBeNull();

	await writeValidatedSha(guideDir, "abc123");
	const after = await buildGuide(guideDir, repo);
	if (after.kind !== "ok") throw new Error(JSON.stringify(after));
	expect(after.validatedSha).toBe("abc123");
	expect(after.version).toBe(before.version);
	expect(after.code).toBe(before.code);
});

test("a legacy guide has no validatedSha", async () => {
	const repo = await gitRepo();
	const legacy = join(repo, ".nisi/guide");
	await guideIn(legacy, "# hi\n");
	const built = await buildGuide(legacy, repo);
	if (built.kind !== "ok") throw new Error(JSON.stringify(built));
	expect(built.validatedSha).toBeNull();
});
