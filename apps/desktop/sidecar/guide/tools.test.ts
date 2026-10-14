import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewRepoGuide, validateRepoGuide } from "./tools.ts";

const repos: string[] = [];

async function git(cwd: string, ...args: string[]) {
	const proc = Bun.spawn(
		["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ cwd, stdout: "ignore", stderr: "inherit" },
	);
	expect(await proc.exited).toBe(0);
}

/** A repo on `main` with one commit, then a second commit that changes `src/a.ts`. */
async function repoWithGuide(guide: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "nisi-guide-tools-"));
	repos.push(dir);
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
	await mkdir(join(dir, ".nisi/guide"), { recursive: true });
	await Bun.write(join(dir, ".nisi/guide/guide.mdx"), guide);
	return dir;
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
	const report = await validateRepoGuide(uncovered, "main");
	expect(report.base).toBe("main");
	expect(report.changedFiles).toBe(1);
	expect(report.issues.map((issue) => issue.message).join("\n")).toContain(
		"src/a.ts",
	);

	const covered = await repoWithGuide(COVERING);
	expect((await validateRepoGuide(covered, "main")).issues).toEqual([]);
	expect("localStorage" in globalThis).toBe(false);
});

test("preview returns the body and the reading, and fails on a missing guide", async () => {
	const dir = await repoWithGuide(COVERING);
	const preview = await previewRepoGuide(dir, "main", {
		expand: true,
		withCss: false,
	});
	expect(preview.html).toContain("It changes a.");
	expect(preview.text).toContain("## Overview");
	expect(preview.css).toBeUndefined();
	expect("localStorage" in globalThis).toBe(false);

	await rm(join(dir, ".nisi/guide/guide.mdx"));
	await expect(
		previewRepoGuide(dir, "main", { expand: false, withCss: false }),
	).rejects.toThrow("There is no guide");
});
