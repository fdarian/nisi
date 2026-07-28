import { describe, expect, test } from "bun:test";
import { parseHunks } from "../src/hunk.ts";

describe("parseHunks", () => {
	test("parses a single hunk with explicit line counts", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"index 111..222 100644",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,3 +1,4 @@",
			" line1",
			"+line2",
			" line3",
			" line4",
			"",
		].join("\n");

		const hunks = parseHunks(patch);
		expect(hunks).toHaveLength(1);
		expect(hunks[0]).toMatchObject({
			oldStart: 1,
			oldLines: 3,
			newStart: 1,
			newLines: 4,
		});
		expect(hunks[0]?.lines).toEqual([" line1", "+line2", " line3", " line4"]);
	});

	test("defaults an omitted line count to 1", () => {
		const patch = ["@@ -5 +5,2 @@", " context", "+added", ""].join("\n");
		const hunks = parseHunks(patch);
		expect(hunks[0]).toMatchObject({
			oldStart: 5,
			oldLines: 1,
			newStart: 5,
			newLines: 2,
		});
	});

	test("parses multiple hunks in one patch", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,2 @@",
			"-old1",
			"+new1",
			" line2",
			"@@ -10,2 +10,3 @@",
			" line10",
			"+added",
			" line11",
			"",
		].join("\n");

		const hunks = parseHunks(patch);
		expect(hunks).toHaveLength(2);
		expect(hunks[0]?.header).toBe("@@ -1,2 +1,2 @@");
		expect(hunks[1]?.header).toBe("@@ -10,2 +10,3 @@");
		expect(hunks[1]?.lines).toEqual([" line10", "+added", " line11"]);
	});

	test("keeps a trailing function-context suffix in the header", () => {
		const patch = ["@@ -1,2 +1,2 @@ function foo() {", " a", " b", ""].join(
			"\n",
		);
		const hunks = parseHunks(patch);
		expect(hunks[0]?.header).toBe("@@ -1,2 +1,2 @@ function foo() {");
	});

	test("returns no hunks for a patch with no @@ headers", () => {
		expect(
			parseHunks("diff --git a/a b/a\nBinary files differ\n"),
		).toHaveLength(0);
	});
});
