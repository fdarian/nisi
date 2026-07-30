import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { getChangedFiles, getFileContents } from "../src/diff.ts";
import { cleanupTestRepo, makeTestRepo, type TestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/**
 * Sets up main-branch content, then a feature branch with committed history
 * to diff against — plus an uncommitted edit and an untracked file layered
 * on top. That layer drives both modes: with `includeUncommitted` unset (or
 * `false`), none of it may leak into `getChangedFiles`/`getFileContents`; with
 * `includeUncommitted: true`, all of it must show up.
 */
const makeScenario = async (): Promise<{ repo: TestRepo; base: string }> => {
	const repo = await makeTestRepo();
	await repo.write("src/kept.ts", "unchanged\n");
	await repo.write("src/modified.ts", "line1\nline2\nline3\n");
	await repo.write("src/to-delete.ts", "will be removed\n");
	await repo.write(
		"src/old-name.ts",
		"renamed content that is long enough for gits similarity heuristic to pair it up as a rename\n",
	);
	const base = await repo.commit("base");

	await repo.git(["checkout", "-q", "-b", "feature"]);
	await repo.write("src/modified.ts", "line1\nline2 changed\nline3\n");
	await repo.git(["rm", "-q", "src/to-delete.ts"]);
	await repo.git(["mv", "src/old-name.ts", "src/new-name.ts"]);
	await repo.write("src/added.ts", "brand new tracked file\n");
	await repo.git(["add", "-A"]);
	await repo.commit("feature work");

	// Uncommitted + untracked on top — must never surface in a diff scoped to
	// committed history only.
	await repo.write("src/kept.ts", "dirtied on disk, never committed\n");
	await repo.write(
		"src/modified.ts",
		"line1\nline2 changed\nline3\nline4 uncommitted\n",
	);
	await repo.write("src/untracked.ts", "not yet added\n");

	return { repo, base };
};

describe("getChangedFiles", () => {
	test("reports the expected status for each kind of change", async () => {
		const { repo, base } = await makeScenario();
		try {
			const files = await run(getChangedFiles(repo.root, base));
			const byPath = new Map(files.map((file) => [file.path, file]));

			expect(byPath.get("src/kept.ts")).toBeUndefined();
			expect(byPath.get("src/modified.ts")?.status).toBe("modified");
			expect(byPath.get("src/to-delete.ts")?.status).toBe("deleted");
			expect(byPath.get("src/new-name.ts")?.status).toBe("renamed");
			expect(byPath.get("src/new-name.ts")?.oldPath).toBe("src/old-name.ts");
			expect(byPath.get("src/added.ts")?.status).toBe("added");
			expect(byPath.get("src/untracked.ts")).toBeUndefined();
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("excludes uncommitted worktree edits from additions/deletions", async () => {
		const { repo, base } = await makeScenario();
		try {
			const files = await run(getChangedFiles(repo.root, base));
			const modified = files.find((file) => file.path === "src/modified.ts");
			// Only the committed "line2 changed" survives (+1/-1) — the
			// uncommitted "line4" addition must not be counted.
			expect(modified?.additions).toBe(1);
			expect(modified?.deletions).toBe(1);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("gives every changed file a fingerprint that changes when its content does", async () => {
		const { repo, base } = await makeScenario();
		try {
			const before = await run(getChangedFiles(repo.root, base));
			const beforeFingerprint = before.find(
				(f) => f.path === "src/modified.ts",
			)?.fingerprint;

			await repo.write(
				"src/modified.ts",
				"line1\nline2 changed again\nline3\n",
			);
			await repo.commit("modify again");
			const after = await run(getChangedFiles(repo.root, base));
			const afterFingerprint = after.find(
				(f) => f.path === "src/modified.ts",
			)?.fingerprint;

			expect(beforeFingerprint).toBeDefined();
			expect(afterFingerprint).toBeDefined();
			expect(afterFingerprint).not.toBe(beforeFingerprint);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("detects a binary file from a NUL byte and marks additions/deletions as 0", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("readme.md", "hello\n");
			const base = await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.writeBytes(
				"image.png",
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
			);
			await repo.commit("add binary");

			const files = await run(getChangedFiles(repo.root, base));
			const image = files.find((file) => file.path === "image.png");
			expect(image?.binary).toBe(true);
			expect(image?.additions).toBe(0);
			expect(image?.deletions).toBe(0);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("classifies a lockfile as generated and a *.test.ts file as test", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("readme.md", "hello\n");
			const base = await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.write("bun.lock", "{}\n");
			await repo.write("src/widget.test.ts", "test('x', () => {})\n");
			await repo.write("src/widget.ts", "export const widget = 1;\n");
			await repo.commit("add files");

			const files = await run(getChangedFiles(repo.root, base));
			const byPath = new Map(files.map((file) => [file.path, file]));
			expect(byPath.get("bun.lock")?.category).toBe("generated");
			expect(byPath.get("src/widget.test.ts")?.category).toBe("test");
			expect(byPath.get("src/widget.ts")?.category).toBe("implementation");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("includes dirtied and untracked files when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const files = await run(
				getChangedFiles(repo.root, base, { includeUncommitted: true }),
			);
			const byPath = new Map(files.map((file) => [file.path, file]));

			// Dirtied on disk but never committed — invisible in the default mode.
			expect(byPath.get("src/kept.ts")?.status).toBe("modified");
			expect(byPath.get("src/untracked.ts")?.status).toBe("added");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("includes uncommitted worktree edits in additions/deletions when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const files = await run(
				getChangedFiles(repo.root, base, { includeUncommitted: true }),
			);
			const modified = files.find((file) => file.path === "src/modified.ts");
			// line2 changed (+1/-1) and line4 added (+1) relative to base.
			expect(modified?.additions).toBe(2);
			expect(modified?.deletions).toBe(1);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});

describe("getFileContents", () => {
	test("returns old and new content for a modified file, excluding uncommitted edits", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/modified.ts" }]),
			);
			const content = batched.get("src/modified.ts");
			expect(content?.oldContent).toBe("line1\nline2\nline3\n");
			expect(content?.newContent).toBe("line1\nline2 changed\nline3\n");
			expect(content?.patch).toContain("-line2");
			expect(content?.patch).toContain("+line2 changed");
			expect(content?.patch).not.toContain("line4 uncommitted");
			expect(content?.truncated).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("has no old content for an added file", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/added.ts" }]),
			);
			const content = batched.get("src/added.ts");
			expect(content?.oldContent).toBeUndefined();
			expect(content?.newContent).toBe("brand new tracked file\n");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("has no new content for a deleted file", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/to-delete.ts" }]),
			);
			const content = batched.get("src/to-delete.ts");
			expect(content?.oldContent).toBe("will be removed\n");
			expect(content?.newContent).toBeUndefined();
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("omits an untracked file's content by default (no committed content to load)", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/untracked.ts" }]),
			);
			expect(batched.has("src/untracked.ts")).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("resolves a rename against its old-side content", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/new-name.ts" }]),
			);
			const content = batched.get("src/new-name.ts");
			expect(content?.oldContent).toContain("renamed content");
			expect(content?.newContent).toContain("renamed content");
			expect(content?.patch).toContain("rename from src/old-name.ts");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("gates content above the auto-render limit until force is set", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("readme.md", "hello\n");
			const base = await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);
			// Just over the 1MB auto-render limit, under the 2MB load-on-demand ceiling.
			await repo.write("big.txt", "a".repeat(1024 * 1024 + 10));
			await repo.commit("add big file");

			const gated = await run(
				getFileContents(repo.root, base, [{ path: "big.txt" }]),
			);
			expect(gated.get("big.txt")?.newContent).toBeUndefined();
			expect(gated.get("big.txt")?.truncated).toBe(true);

			const forced = await run(
				getFileContents(repo.root, base, [{ path: "big.txt", force: true }]),
			);
			expect(forced.get("big.txt")?.newContent).toBeDefined();
			expect(forced.get("big.txt")?.newContent?.length).toBe(1024 * 1024 + 10);
			expect(forced.get("big.txt")?.truncated).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("never loads content past the patch-only ceiling, even with force", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("readme.md", "hello\n");
			const base = await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.write("huge.txt", "a".repeat(2 * 1024 * 1024 + 10));
			await repo.commit("add huge file");

			const forced = await run(
				getFileContents(repo.root, base, [{ path: "huge.txt", force: true }]),
			);
			expect(forced.get("huge.txt")?.newContent).toBeUndefined();
			expect(forced.get("huge.txt")?.truncated).toBe(true);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("omits a requested path that isn't part of the diff", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [
					{ path: "src/kept.ts" },
					{ path: "src/modified.ts" },
				]),
			);
			expect(batched.has("src/kept.ts")).toBe(false);
			expect(batched.has("src/modified.ts")).toBe(true);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns an empty map for an empty request list", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(getFileContents(repo.root, base, []));
			expect(batched.size).toBe(0);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("respects a per-path force flag within the same batch", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("small.txt", "small\n");
			const base = await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.write("small.txt", "small changed\n");
			await repo.write("big.txt", "a".repeat(1024 * 1024 + 10));
			await repo.commit("add big file");

			const batched = await run(
				getFileContents(repo.root, base, [
					{ path: "small.txt" },
					{ path: "big.txt", force: true },
				]),
			);

			expect(batched.get("small.txt")?.newContent).toBe("small changed\n");
			expect(batched.get("big.txt")?.newContent?.length).toBe(1024 * 1024 + 10);
			expect(batched.get("big.txt")?.truncated).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("gates an unforced path even when another path in the batch is forced", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("readme.md", "hello\n");
			const base = await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.write("big-a.txt", "a".repeat(1024 * 1024 + 10));
			await repo.write("big-b.txt", "b".repeat(1024 * 1024 + 10));
			await repo.commit("add big files");

			const batched = await run(
				getFileContents(repo.root, base, [
					{ path: "big-a.txt", force: true },
					{ path: "big-b.txt" },
				]),
			);

			expect(batched.get("big-a.txt")?.newContent).toBeDefined();
			expect(batched.get("big-a.txt")?.truncated).toBe(false);
			expect(batched.get("big-b.txt")?.newContent).toBeUndefined();
			expect(batched.get("big-b.txt")?.truncated).toBe(true);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns worktree content for a modified file when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/modified.ts" }], {
					includeUncommitted: true,
				}),
			);
			const content = batched.get("src/modified.ts");
			expect(content?.oldContent).toBe("line1\nline2\nline3\n");
			expect(content?.newContent).toBe(
				"line1\nline2 changed\nline3\nline4 uncommitted\n",
			);
			expect(content?.patch).toContain("-line2");
			expect(content?.patch).toContain("+line2 changed");
			expect(content?.truncated).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("synthesizes a patch for an untracked file when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/untracked.ts" }], {
					includeUncommitted: true,
				}),
			);
			const content = batched.get("src/untracked.ts");
			expect(content?.oldContent).toBeUndefined();
			expect(content?.newContent).toBe("not yet added\n");
			expect(content?.patch).toContain("+not yet added");
			expect(content?.patch).toContain("new file mode");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("succeeds for a path dirtied only on disk when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const batched = await run(
				getFileContents(repo.root, base, [{ path: "src/kept.ts" }], {
					includeUncommitted: true,
				}),
			);
			const content = batched.get("src/kept.ts");
			expect(content?.oldContent).toBe("unchanged\n");
			expect(content?.newContent).toBe("dirtied on disk, never committed\n");
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
