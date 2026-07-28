import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	createAddedFilePatch,
	patchLooksBinary,
	readPatches,
	splitPatch,
} from "../src/patch.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

describe("splitPatch", () => {
	test("splits a combined patch into one entry per file, keyed by the new path", () => {
		const combined = [
			"diff --git a/a.ts b/a.ts",
			"index 111..222 100644",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"diff --git a/b.ts b/b.ts",
			"index 333..444 100644",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -1 +1 @@",
			"-x",
			"+y",
			"",
		].join("\n");

		const split = splitPatch(combined);
		expect([...split.keys()]).toEqual(["a.ts", "b.ts"]);
		expect(split.get("a.ts")).toContain("-old");
		expect(split.get("a.ts")).not.toContain("-x");
		expect(split.get("b.ts")).toContain("+y");
	});

	test("keys a rename by the new-side path", () => {
		const combined = [
			"diff --git a/old-name.ts b/new-name.ts",
			"similarity index 100%",
			"rename from old-name.ts",
			"rename to new-name.ts",
			"",
		].join("\n");

		const split = splitPatch(combined);
		expect([...split.keys()]).toEqual(["new-name.ts"]);
	});

	test("returns an empty map for an empty patch", () => {
		expect(splitPatch("").size).toBe(0);
	});
});

describe("patchLooksBinary", () => {
	test("matches git's binary marker anchored to line start", () => {
		expect(patchLooksBinary("Binary files a/x.png and b/x.png differ")).toBe(
			true,
		);
		expect(
			patchLooksBinary(
				"diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n",
			),
		).toBe(true);
	});

	test("doesn't match ordinary text patches", () => {
		expect(patchLooksBinary("@@ -1 +1 @@\n-old\n+new\n")).toBe(false);
	});

	test("doesn't match the phrase appearing mid-line, only at line start", () => {
		expect(
			patchLooksBinary("+// see: Binary files a and b differ (a comment)"),
		).toBe(false);
	});
});

describe("createAddedFilePatch", () => {
	test("synthesizes a unified diff with every line marked as an addition", () => {
		const patch = createAddedFilePatch("new.ts", "line1\nline2\n");
		expect(patch).toContain("diff --git a/new.ts b/new.ts");
		expect(patch).toContain("new file mode 100644");
		expect(patch).toContain("--- /dev/null");
		expect(patch).toContain("+++ b/new.ts");
		expect(patch).toContain("@@ -0,0 +1,2 @@");
		expect(patch).toContain("+line1");
		expect(patch).toContain("+line2");
	});

	test("marks a missing trailing newline", () => {
		const patch = createAddedFilePatch("new.ts", "line1");
		expect(patch).toContain("\\ No newline at end of file");
	});

	test("handles empty file content", () => {
		const patch = createAddedFilePatch("empty.ts", "");
		expect(patch).toContain("@@ -0,0 +1,0 @@");
	});
});

describe("readPatches", () => {
	test("fetches patches for multiple files in one combined diff call", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "line1\nline2\n");
			await repo.write("b.ts", "hello\n");
			const base = await repo.commit("initial");

			await repo.write("a.ts", "line1\nline2 changed\n");
			await repo.write("b.ts", "hello world\n");

			const patches = await Effect.runPromise(
				readPatches(repo.root, base, [{ path: "a.ts" }, { path: "b.ts" }]).pipe(
					Effect.provide(BunServices.layer),
				),
			);

			expect(patches.get("a.ts")).toContain("-line2");
			expect(patches.get("a.ts")).toContain("+line2 changed");
			expect(patches.get("b.ts")).toContain("+hello world");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("resolves a rename's patch keyed by its new path", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write(
				"old.ts",
				"content that is definitely long enough to be detected as a rename by git's similarity heuristic\n",
			);
			const base = await repo.commit("initial");

			await repo.git(["mv", "old.ts", "renamed.ts"]);
			await repo.commit("rename");

			const patches = await Effect.runPromise(
				readPatches(repo.root, base, [
					{ path: "renamed.ts", oldPath: "old.ts" },
				]).pipe(Effect.provide(BunServices.layer)),
			);

			expect(patches.has("renamed.ts")).toBe(true);
			expect(patches.get("renamed.ts")).toContain("rename from old.ts");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns an empty map for an empty path list", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "content\n");
			const base = await repo.commit("initial");
			const patches = await Effect.runPromise(
				readPatches(repo.root, base, []).pipe(
					Effect.provide(BunServices.layer),
				),
			);
			expect(patches.size).toBe(0);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
