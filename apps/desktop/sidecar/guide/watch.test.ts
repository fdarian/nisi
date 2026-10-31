import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { watchGuideFolder } from "./watch.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** The folder sits under parents that don't exist yet, as a branch's central folder does before its first guide. */
async function watchedFolder() {
	const root = await mkdtemp(join(tmpdir(), "nisi-guide-watch-"));
	const folder = join(root, "owner/repo/feature%2Fx");
	let changes = 0;
	const watcher = watchGuideFolder(
		folder,
		() => {
			changes += 1;
		},
		(cause) => {
			throw cause;
		},
	);
	cleanups.push(
		() => watcher.close(),
		() => rm(root, { recursive: true, force: true }),
	);
	// FSEvents starts delivering a beat after `watch` returns; under load an immediate write is missed.
	await Bun.sleep(200);
	return { folder, changes: () => changes };
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

test("a guide folder created from nothing, edited, given checks, and removed each report a change", async () => {
	const { folder, changes } = await watchedFolder();

	expect(
		await changesAfter(changes, async () => {
			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, "guide.mdx"), "# one\n");
		}),
	).toBe(1);

	expect(
		await changesAfter(changes, () =>
			writeFile(join(folder, "guide.mdx"), "# two\n"),
		),
	).toBe(1);

	expect(
		await changesAfter(changes, async () => {
			await mkdir(join(folder, "checks"));
			await writeFile(join(folder, "checks/a.json"), "{}");
		}),
	).toBe(1);

	expect(
		await changesAfter(changes, () =>
			writeFile(join(folder, "meta.json"), '{"validatedSha":"abc"}'),
		),
	).toBe(1);

	expect(
		await changesAfter(changes, () => rm(folder, { recursive: true })),
	).toBe(1);

	// The watch follows the guide coming back after it was removed.
	expect(
		await changesAfter(changes, async () => {
			await mkdir(folder, { recursive: true });
			await writeFile(join(folder, "guide.mdx"), "# three\n");
		}),
	).toBe(1);
});

test("sibling branches' folders report nothing", async () => {
	const { folder, changes } = await watchedFolder();
	await Bun.sleep(400);

	expect(
		await changesAfter(changes, async () => {
			const sibling = join(dirname(folder), "other-branch");
			await mkdir(sibling, { recursive: true });
			await writeFile(join(sibling, "guide.mdx"), "# other\n");
			await writeFile(join(dirname(folder), "stray.json"), "{}");
		}),
	).toBe(0);
});
