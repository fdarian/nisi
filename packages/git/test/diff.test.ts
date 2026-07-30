import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { getChangedFiles, getFileContent } from "../src/diff.ts";
import { cleanupTestRepo, makeTestRepo, type TestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/**
 * Sets up main-branch content, then a feature branch with committed history
 * to diff against — plus an uncommitted edit and an untracked file layered
 * on top. That layer drives both modes: with `includeUncommitted` unset (or
 * `false`), none of it may leak into `getChangedFiles`/`getFileContent`; with
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

describe("getFileContent", () => {
	test("returns old and new content for a modified file, excluding uncommitted edits", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/modified.ts"),
			);
			expect(content.oldContent).toBe("line1\nline2\nline3\n");
			expect(content.newContent).toBe("line1\nline2 changed\nline3\n");
			expect(content.patch).toContain("-line2");
			expect(content.patch).toContain("+line2 changed");
			expect(content.patch).not.toContain("line4 uncommitted");
			expect(content.truncated).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("has no old content for an added file", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/added.ts"),
			);
			expect(content.oldContent).toBeUndefined();
			expect(content.newContent).toBe("brand new tracked file\n");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("has no new content for a deleted file", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/to-delete.ts"),
			);
			expect(content.oldContent).toBe("will be removed\n");
			expect(content.newContent).toBeUndefined();
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("fails with FileNotChanged for an untracked file", async () => {
		const { repo, base } = await makeScenario();
		try {
			const exit = await Effect.runPromiseExit(
				getFileContent(repo.root, base, "src/untracked.ts").pipe(
					Effect.provide(BunServices.layer),
				),
			);
			expect(exit._tag).toBe("Failure");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("resolves a rename against its old-side content", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/new-name.ts"),
			);
			expect(content.oldContent).toContain("renamed content");
			expect(content.newContent).toContain("renamed content");
			expect(content.patch).toContain("rename from src/old-name.ts");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("fails with FileNotChanged for a path outside the diff, even when dirtied uncommitted", async () => {
		const { repo, base } = await makeScenario();
		try {
			const exit = await Effect.runPromiseExit(
				getFileContent(repo.root, base, "src/kept.ts").pipe(
					Effect.provide(BunServices.layer),
				),
			);
			expect(exit._tag).toBe("Failure");
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

			const gated = await run(getFileContent(repo.root, base, "big.txt"));
			expect(gated.newContent).toBeUndefined();
			expect(gated.truncated).toBe(true);

			const forced = await run(
				getFileContent(repo.root, base, "big.txt", { force: true }),
			);
			expect(forced.newContent).toBeDefined();
			expect(forced.newContent?.length).toBe(1024 * 1024 + 10);
			expect(forced.truncated).toBe(false);
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
				getFileContent(repo.root, base, "huge.txt", { force: true }),
			);
			expect(forced.newContent).toBeUndefined();
			expect(forced.truncated).toBe(true);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns worktree content for a modified file when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/modified.ts", {
					includeUncommitted: true,
				}),
			);
			expect(content.oldContent).toBe("line1\nline2\nline3\n");
			expect(content.newContent).toBe(
				"line1\nline2 changed\nline3\nline4 uncommitted\n",
			);
			expect(content.patch).toContain("-line2");
			expect(content.patch).toContain("+line2 changed");
			expect(content.truncated).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("synthesizes a patch for an untracked file when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/untracked.ts", {
					includeUncommitted: true,
				}),
			);
			expect(content.oldContent).toBeUndefined();
			expect(content.newContent).toBe("not yet added\n");
			expect(content.patch).toContain("+not yet added");
			expect(content.patch).toContain("new file mode");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("succeeds for a path dirtied only on disk when includeUncommitted is true", async () => {
		const { repo, base } = await makeScenario();
		try {
			const content = await run(
				getFileContent(repo.root, base, "src/kept.ts", {
					includeUncommitted: true,
				}),
			);
			expect(content.oldContent).toBe("unchanged\n");
			expect(content.newContent).toBe("dirtied on disk, never committed\n");
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
