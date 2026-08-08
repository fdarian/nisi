import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { diffContents, diffContentsPatch } from "../src/content-diff.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("diffContents", () => {
	test("returns no hunks for identical content", async () => {
		const repo = await makeTestRepo();
		try {
			const hunks = await run(
				diffContents(repo.root, "line1\nline2\n", "line1\nline2\n"),
			);
			expect(hunks).toHaveLength(0);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("reports an added-lines hunk with correct new-side range", async () => {
		const repo = await makeTestRepo();
		try {
			const hunks = await run(
				diffContents(
					repo.root,
					"line1\nline2\nline3\n",
					"line1\nline2\ninserted\nline3\n",
				),
			);
			expect(hunks).toHaveLength(1);
			expect(hunks[0]).toMatchObject({
				oldStart: 2,
				oldLines: 0,
				newStart: 3,
				newLines: 1,
			});
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("reports a removed-lines hunk with newLines 0", async () => {
		const repo = await makeTestRepo();
		try {
			const hunks = await run(
				diffContents(repo.root, "line1\nline2\nline3\n", "line1\nline3\n"),
			);
			expect(hunks).toHaveLength(1);
			expect(hunks[0]).toMatchObject({
				oldStart: 2,
				oldLines: 1,
				newStart: 1,
				newLines: 0,
			});
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("reports two separate hunks for two separate edits", async () => {
		const repo = await makeTestRepo();
		try {
			const oldLines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`);
			const newLines = [...oldLines];
			newLines[4] = "line5 EDITED";
			newLines[14] = "line15 EDITED";

			const hunks = await run(
				diffContents(
					repo.root,
					`${oldLines.join("\n")}\n`,
					`${newLines.join("\n")}\n`,
				),
			);

			expect(hunks).toHaveLength(2);
			expect(hunks[0]).toMatchObject({ newStart: 5, newLines: 1 });
			expect(hunks[1]).toMatchObject({ newStart: 15, newLines: 1 });
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("re-diffing the same content pair repeatedly doesn't error (odb dedup)", async () => {
		const repo = await makeTestRepo();
		try {
			const first = await run(diffContents(repo.root, "a\n", "b\n"));
			const second = await run(diffContents(repo.root, "a\n", "b\n"));
			expect(first).toEqual(second);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});

describe("diffContentsPatch", () => {
	test("returns an empty string for identical content", async () => {
		const repo = await makeTestRepo();
		try {
			const patch = await run(
				diffContentsPatch(repo.root, "some/file.ts", "same\n", "same\n"),
			);
			expect(patch).toBe("");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("headers the patch with the real path, not the blobs' shas", async () => {
		const repo = await makeTestRepo();
		try {
			const patch = await run(
				diffContentsPatch(
					repo.root,
					"some/file.ts",
					"line1\nline2\n",
					"line1\nline2 EDITED\n",
				),
			);
			expect(patch).toContain("diff --git a/some/file.ts b/some/file.ts");
			expect(patch).toContain("--- a/some/file.ts");
			expect(patch).toContain("+++ b/some/file.ts");
			expect(patch).toContain("-line2\n+line2 EDITED");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("carries real context lines, unlike diffContents' -U0 hunks", async () => {
		const repo = await makeTestRepo();
		try {
			const oldLines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
			const newLines = [...oldLines];
			newLines[4] = "line5 EDITED";

			const patch = await run(
				diffContentsPatch(
					repo.root,
					"f.txt",
					`${oldLines.join("\n")}\n`,
					`${newLines.join("\n")}\n`,
				),
			);
			expect(patch).toContain(" line4\n");
			expect(patch).toContain(" line6\n");
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
