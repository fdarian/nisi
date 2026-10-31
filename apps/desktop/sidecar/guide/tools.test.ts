import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuide } from "./build.ts";
import { previewRepoGuide, validateRepoGuide } from "./tools.ts";

const repos: string[] = [];

type Fixture = { repo: string; guideDir: string };

async function git(cwd: string, ...args: string[]) {
	const proc = Bun.spawn(
		["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ cwd, stdout: "ignore", stderr: "inherit" },
	);
	expect(await proc.exited).toBe(0);
}

/** A repo on `main` with one commit, then a second commit that changes `src/a.ts`; the guide sits in a folder of its own, as in the central store. */
async function repoWithGuide(guide: string): Promise<Fixture> {
	const dir = await mkdtemp(join(tmpdir(), "nisi-guide-tools-"));
	const guideDir = await mkdtemp(join(tmpdir(), "nisi-guide-folder-"));
	repos.push(dir, guideDir);
	await git(dir, "init", "-q", "-b", "main");
	await mkdir(join(dir, "src"));
	await Bun.write(join(dir, "src/a.ts"), "export const a = 1;\n");
	await git(dir, "add", ".");
	await git(dir, "commit", "-q", "-m", "base");
	await git(dir, "checkout", "-q", "-b", "feature");
	await Bun.write(
		join(dir, "src/a.ts"),
		"export const a = 2;\nexport const b = 3;\n",
	);
	await git(dir, "commit", "-qam", "change");
	await Bun.write(join(guideDir, "guide.mdx"), guide);
	return { repo: dir, guideDir };
}

afterEach(async () => {
	await Promise.all(
		repos.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const COVERING = `## Overview

It changes a.

<Areas>
  <Area id="a" title="A" paths={["src/**"]}>
    - Changes <Ref path="src/a.ts" />.
  </Area>
</Areas>
`;

test("validate reports an uncovered change and a clean guide, and leaves no localStorage behind", async () => {
	const uncovered = await repoWithGuide(
		COVERING.replace('"src/**"', '"docs/**"'),
	);
	const report = await validateRepoGuide(
		uncovered.guideDir,
		uncovered.repo,
		"main",
	);
	expect(report.base).toBe("main");
	expect(report.changedFiles).toBe(1);
	expect(report.issues.map((issue) => issue.message).join("\n")).toContain(
		"src/a.ts",
	);

	const covered = await repoWithGuide(COVERING);
	expect(
		(await validateRepoGuide(covered.guideDir, covered.repo, "main")).issues,
	).toEqual([]);
	expect("localStorage" in globalThis).toBe(false);
});

test("preview returns the body and the reading, and fails on a missing guide", async () => {
	const fixture = await repoWithGuide(COVERING);
	const preview = await previewRepoGuide(
		fixture.guideDir,
		fixture.repo,
		"main",
		{
			expand: true,
			withCss: false,
		},
	);
	expect(preview.html).toContain("It changes a.");
	expect(preview.text).toContain("## Overview");
	expect(preview.css).toBeUndefined();
	expect("localStorage" in globalThis).toBe(false);

	await rm(join(fixture.guideDir, "guide.mdx"));
	await expect(
		previewRepoGuide(fixture.guideDir, fixture.repo, "main", {
			expand: false,
			withCss: false,
		}),
	).rejects.toThrow("There is no guide");
});

const META = (guideDir: string) => join(guideDir, "meta.json");

async function headOf(repo: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
		cwd: repo,
		stdout: "pipe",
	});
	return (await new Response(proc.stdout).text()).trim();
}

test("a clean validate stamps meta.json with HEAD, and the stamp doesn't move the version", async () => {
	const { repo, guideDir } = await repoWithGuide(COVERING);
	const before = await buildGuide(guideDir, repo);
	if (before.kind !== "ok") throw new Error(JSON.stringify(before));

	expect((await validateRepoGuide(guideDir, repo, "main")).issues).toEqual([]);
	expect(await Bun.file(META(guideDir)).json()).toEqual({
		validatedSha: await headOf(repo),
	});

	const after = await buildGuide(guideDir, repo);
	if (after.kind !== "ok") throw new Error(JSON.stringify(after));
	expect(after.version).toBe(before.version);
	expect(after.validatedSha).toBe(await headOf(repo));
});

test("a validate with an error-level issue writes no meta.json", async () => {
	const { repo, guideDir } = await repoWithGuide(
		COVERING.replace('"src/**"', '"docs/**"'),
	);
	const report = await validateRepoGuide(guideDir, repo, "main");
	expect(report.issues.some((issue) => issue.level === "error")).toBe(true);
	expect(await Bun.file(META(guideDir)).exists()).toBe(false);
});

test("validating a folder with no guide writes no meta.json", async () => {
	const { repo, guideDir } = await repoWithGuide(COVERING);
	await rm(join(guideDir, "guide.mdx"));
	await validateRepoGuide(guideDir, repo, "main");
	expect(await Bun.file(META(guideDir)).exists()).toBe(false);
});
