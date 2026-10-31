import { afterEach, expect, test } from "bun:test";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCheck } from "./check.ts";

const repos: string[] = [];

async function tempRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nisi-check-"));
	repos.push(dir, guideFolderOf(dir));
	for (const args of [
		["init", "-q"],
		[
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		],
	]) {
		await Bun.spawn(["git", ...args], { cwd: dir }).exited;
	}
	return dir;
}

afterEach(async () => {
	await Promise.all(
		repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/** Where the guide folder is for every test: outside the repo, as in production. */
const guideFolderOf = (repo: string) => `${repo}-guide`;

async function readRecord(repo: string, slug: string) {
	return JSON.parse(
		await readFile(join(guideFolderOf(repo), "checks", `${slug}.json`), "utf8"),
	);
}

test("records an argv run and returns its exit code", async () => {
	const repo = await tempRepo();
	const code = await recordCheck(repo, guideFolderOf(repo), "Type check", [
		"sh",
		"-c",
		"echo out; echo err >&2; exit 2",
	]);
	expect(code).toBe(2);
	const record = await readRecord(repo, "type-check");
	expect(record.title).toBe("Type check");
	expect(record.exitCode).toBe(2);
	expect(record.command).toBe("sh -c 'echo out; echo err >&2; exit 2'");
	expect(record.sha).toMatch(/^[0-9a-f]{40}$/);
	expect(record.output.split("\n").sort()).toEqual(["err", "out"]);
});

test("a single argument is a shell line", async () => {
	const repo = await tempRepo();
	const code = await recordCheck(repo, guideFolderOf(repo), "Chained", [
		"echo a && echo b",
	]);
	expect(code).toBe(0);
	expect((await readRecord(repo, "chained")).command).toBe("echo a && echo b");
});

test("the same title overwrites, and output keeps only the last lines", async () => {
	const repo = await tempRepo();
	await recordCheck(repo, guideFolderOf(repo), "Loud", ["seq 1 100"]);
	await recordCheck(repo, guideFolderOf(repo), "Loud", ["seq 1 100"]);
	const lines = (await readRecord(repo, "loud")).output.split("\n");
	expect(lines).toHaveLength(40);
	expect(lines.at(-1)).toBe("100");
});

test("a title with nothing to name a file by is rejected before running anything", async () => {
	const repo = await tempRepo();
	await expect(
		recordCheck(repo, guideFolderOf(repo), "!!!", ["true"]),
	).rejects.toThrow("nothing to name a file by");
});

test("dirty records uncommitted changes outside .nisi, and ignores .nisi itself", async () => {
	const repo = await tempRepo();
	await recordCheck(repo, guideFolderOf(repo), "Clean", ["true"]);
	expect((await readRecord(repo, "clean")).dirty).toBe(false);

	// A guide left under .nisi by an earlier version must not count either.
	await mkdir(join(repo, ".nisi/guide"), { recursive: true });
	await writeFile(join(repo, ".nisi/guide/guide.mdx"), "## Overview\n");
	await recordCheck(repo, guideFolderOf(repo), "Still clean", ["true"]);
	expect((await readRecord(repo, "still-clean")).dirty).toBe(false);

	await writeFile(join(repo, "untracked.ts"), "export {};\n");
	await recordCheck(repo, guideFolderOf(repo), "Dirty", ["true"]);
	expect((await readRecord(repo, "dirty")).dirty).toBe(true);
});

test("runs in the checkout and writes to the guide folder, not into the checkout", async () => {
	const repo = await tempRepo();
	await recordCheck(repo, guideFolderOf(repo), "Where", ["pwd"]);
	expect((await readRecord(repo, "where")).output).toBe(await realpath(repo));
	await expect(stat(join(repo, ".nisi"))).rejects.toThrow();
});
