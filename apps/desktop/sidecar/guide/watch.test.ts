import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchGuideFolder } from "./watch.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function watchedRepo() {
	const repo = await mkdtemp(join(tmpdir(), "nisi-guide-watch-"));
	let changes = 0;
	const watcher = watchGuideFolder(
		repo,
		() => {
			changes += 1;
		},
		(cause) => {
			throw cause;
		},
	);
	cleanups.push(
		() => watcher.close(),
		() => rm(repo, { recursive: true, force: true }),
	);
	return { repo, changes: () => changes };
}

/** Waits past the debounce for the count to move; returns how far it moved. */
async function changesAfter(
	read: () => number,
	act: () => Promise<unknown>,
): Promise<number> {
	const before = read();
	await act();
	await Bun.sleep(600);
	return read() - before;
}

test("a guide created from nothing, edited, given checks, and removed each report a change", async () => {
	const { repo, changes } = await watchedRepo();
	const guideDir = join(repo, ".nisi/guide");

	expect(
		await changesAfter(changes, async () => {
			await mkdir(guideDir, { recursive: true });
			await writeFile(join(guideDir, "guide.mdx"), "# one\n");
		}),
	).toBe(1);

	expect(
		await changesAfter(changes, () =>
			writeFile(join(guideDir, "guide.mdx"), "# two\n"),
		),
	).toBe(1);

	expect(
		await changesAfter(changes, async () => {
			await mkdir(join(guideDir, "checks"));
			await writeFile(join(guideDir, "checks/a.json"), "{}");
		}),
	).toBe(1);

	expect(
		await changesAfter(changes, () =>
			rm(join(repo, ".nisi"), { recursive: true }),
		),
	).toBe(1);

	// The watch follows the guide coming back after it was removed.
	expect(
		await changesAfter(changes, async () => {
			await mkdir(guideDir, { recursive: true });
			await writeFile(join(guideDir, "guide.mdx"), "# three\n");
		}),
	).toBe(1);
});

test("unrelated files in the repo and in .nisi report nothing", async () => {
	const { repo, changes } = await watchedRepo();
	await mkdir(join(repo, ".nisi"));
	await Bun.sleep(400);

	expect(
		await changesAfter(changes, async () => {
			await writeFile(join(repo, "a.ts"), "export {};\n");
			await mkdir(join(repo, "src"));
			await writeFile(join(repo, "src/b.ts"), "export {};\n");
			await writeFile(join(repo, ".nisi/other.json"), "{}");
		}),
	).toBe(0);
});
