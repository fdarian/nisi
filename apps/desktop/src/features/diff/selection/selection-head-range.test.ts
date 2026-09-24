import { expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { selectionHeadRange } from "./selection-head-range";

function hunks(patch: string) {
	const file = parsePatchFiles(
		`diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n${patch}`,
	)[0]?.files[0];
	if (!file) throw new Error("Could not parse diff fixture");
	return file.hunks;
}

const replacement = hunks(
	"@@ -10,5 +10,6 @@\n before\n-old\n+first\n+second\n after\n next\n last\n",
);

test("additions only claim the selected HEAD lines", () => {
	expect(
		selectionHeadRange(
			replacement,
			{ line: 11, side: "additions" },
			{ line: 12, side: "additions" },
		),
	).toEqual({ startLine: 11, endLine: 12 });
});

test("context only claims its selected HEAD lines", () => {
	expect(
		selectionHeadRange(
			replacement,
			{ line: 13, side: "additions" },
			{ line: 15, side: "additions" },
		),
	).toEqual({ startLine: 13, endLine: 15 });
});

test("deletion only has no HEAD-side range", () => {
	expect(
		selectionHeadRange(
			replacement,
			{ line: 11, side: "deletions" },
			{ line: 11, side: "deletions" },
		),
	).toBeUndefined();
});

test("deletion at the selection's top edge includes only its adjacent context flank", () => {
	expect(
		selectionHeadRange(
			replacement,
			{ line: 11, side: "deletions" },
			{ line: 11, side: "additions" },
		),
	).toEqual({ startLine: 10, endLine: 11 });
});

test("deletion at the selection's bottom edge includes only its adjacent context flank", () => {
	const deletion = hunks("@@ -20,3 +20,2 @@\n before\n-old\n after\n");
	expect(
		selectionHeadRange(
			deletion,
			{ line: 20, side: "additions" },
			{ line: 21, side: "deletions" },
		),
	).toEqual({ startLine: 20, endLine: 21 });
});

test("unselected additions at a deletion edge are never claimed", () => {
	expect(
		selectionHeadRange(
			replacement,
			{ line: 10, side: "additions" },
			{ line: 11, side: "deletions" },
		),
	).toEqual({ startLine: 10, endLine: 10 });
});

test("a deletion at the file boundary cannot invent a missing context flank", () => {
	const top = hunks("@@ -1,2 +1,2 @@\n-old\n+new\n after\n");
	expect(
		selectionHeadRange(
			top,
			{ line: 1, side: "deletions" },
			{ line: 1, side: "additions" },
		),
	).toEqual({ startLine: 1, endLine: 1 });
	const bottom = hunks("@@ -1,2 +1 @@\n before\n-old\n");
	expect(
		selectionHeadRange(
			bottom,
			{ line: 1, side: "additions" },
			{ line: 2, side: "deletions" },
		),
	).toEqual({ startLine: 1, endLine: 1 });
});

test("a range spanning hunks keeps the full HEAD interval, including collapsed context", () => {
	const multiple = hunks(
		"@@ -1,2 +1,2 @@\n before\n-old\n+first\n@@ -10,2 +10,2 @@\n after\n-old\n+second\n",
	);
	expect(
		selectionHeadRange(
			multiple,
			{ line: 2, side: "additions" },
			{ line: 11, side: "additions" },
		),
	).toEqual({ startLine: 2, endLine: 11 });
});

test("old-side context endpoints map to their HEAD positions", () => {
	const shifted = hunks("@@ -8,3 +10,3 @@\n before\n-old\n+new\n after\n");
	expect(
		selectionHeadRange(
			shifted,
			{ line: 8, side: "deletions" },
			{ line: 10, side: "deletions" },
		),
	).toEqual({ startLine: 10, endLine: 12 });
	expect(
		selectionHeadRange(
			shifted,
			{ line: 10, side: "deletions" },
			{ line: 8, side: "deletions" },
		),
	).toEqual({ startLine: 10, endLine: 12 });
});

const expanded = hunks(
	"@@ -3,2 +3,3 @@\n before\n+inserted\n after\n@@ -12,2 +13,2 @@\n before2\n-old\n+new\n",
);

test("a selection starting in expanded context before a hunk includes the hunk", () => {
	expect(
		selectionHeadRange(
			expanded,
			{ line: 2, side: "deletions" },
			{ line: 4, side: "additions" },
		),
	).toEqual({ startLine: 2, endLine: 4 });
});

test("a selection ending in expanded context after a hunk uses the preceding offset", () => {
	expect(
		selectionHeadRange(
			expanded,
			{ line: 14, side: "additions" },
			{ line: 15, side: "deletions" },
		),
	).toEqual({ startLine: 14, endLine: 16 });
});

test("two expanded-context endpoints spanning a whole hunk cover its changed rows", () => {
	expect(
		selectionHeadRange(
			expanded,
			{ line: 10, side: "deletions" },
			{ line: 15, side: "deletions" },
		),
	).toEqual({ startLine: 11, endLine: 16 });
});

test("expanded old-side context maps across zero-length hunk sides", () => {
	const deletion = hunks("@@ -5,1 +4,0 @@\n-old\n");
	expect(
		selectionHeadRange(
			deletion,
			{ line: 4, side: "deletions" },
			{ line: 6, side: "deletions" },
		),
	).toEqual({ startLine: 4, endLine: 5 });
	const insertion = hunks("@@ -4,0 +5,1 @@\n+added\n");
	expect(
		selectionHeadRange(
			insertion,
			{ line: 4, side: "deletions" },
			{ line: 5, side: "deletions" },
		),
	).toEqual({ startLine: 4, endLine: 6 });
});
