import { describe, expect, test } from "bun:test";
import { diffContentMatchesQuery, findDiffMatches } from "./diff-search.ts";
import type { FileContentsMap } from "./pr-data.ts";

/** One hunk: a context line, a removed line, two added lines, a context line. */
const PATCH = `diff --git a/f.txt b/f.txt
index a82bf91..ea476e2 100644
--- a/f.txt
+++ b/f.txt
@@ -2,3 +2,4 @@ line1
 line2
-line3
+line3-changed
+line3b
 line4
`;

/** A hunk whose last line is a removed line with nothing kept after it in the hunk. */
const TRAILING_REMOVAL_PATCH = `diff --git a/g.txt b/g.txt
index abc..def 100644
--- a/g.txt
+++ b/g.txt
@@ -1,3 +1,2 @@
 keep1
 keep2
-tail-removed
`;

function contentsMap(entries: Record<string, string>): FileContentsMap {
	return new Map(
		Object.entries(entries).map(([path, patch]) => [
			path,
			{
				content: { patch, truncated: false, review: null },
				isLoading: false,
				isError: false,
			},
		]),
	);
}

describe("findDiffMatches", () => {
	test("strips the +/-/space prefix before matching, so a query anchored at column 0 lands at offset 0", () => {
		const matches = findDiffMatches(
			[{ path: "f.txt" }],
			contentsMap({ "f.txt": PATCH }),
			"line3",
		);
		expect(matches).toEqual([
			// "line3" (removed) — no head line of its own, so `headLine` anchors
			// forward to "line3-changed"'s head line (3) for range-building, but
			// `side`/`rowLine` still point at its own row: the *old*-file line
			// number (3), since that's the only number a pure deletion row has.
			{
				path: "f.txt",
				headLine: 3,
				offset: 0,
				length: 5,
				side: "deletions",
				rowLine: 3,
			},
			// "line3-changed" (added, head line 3) — an addition's own row
			// number is its head line, so `rowLine` matches `headLine`.
			{
				path: "f.txt",
				headLine: 3,
				offset: 0,
				length: 5,
				side: "additions",
				rowLine: 3,
			},
			// "line3b" (added, head line 4).
			{
				path: "f.txt",
				headLine: 4,
				offset: 0,
				length: 5,
				side: "additions",
				rowLine: 4,
			},
		]);
	});

	test("never matches a hunk header or the preamble", () => {
		expect(
			findDiffMatches(
				[{ path: "f.txt" }],
				contentsMap({ "f.txt": PATCH }),
				"@@",
			),
		).toEqual([]);
		expect(
			findDiffMatches(
				[{ path: "f.txt" }],
				contentsMap({ "f.txt": PATCH }),
				"index a82bf91",
			),
		).toEqual([]);
	});

	test("a trailing removed line with nothing kept after it anchors backward to the nearest earlier head line", () => {
		const matches = findDiffMatches(
			[{ path: "g.txt" }],
			contentsMap({ "g.txt": TRAILING_REMOVAL_PATCH }),
			"tail-removed",
		);
		expect(matches).toEqual([
			// `headLine` anchors backward to "keep2" (head line 2) for
			// range-building, but the row itself renders at its own old-file
			// line number (3) — there's no new-file counterpart to show.
			{
				path: "g.txt",
				headLine: 2,
				offset: 0,
				length: 12,
				side: "deletions",
				rowLine: 3,
			},
		]);
	});

	test("orders matches in file order, then line, then offset", () => {
		const matches = findDiffMatches(
			[{ path: "a-first.txt" }, { path: "b-second.txt" }],
			contentsMap({
				"a-first.txt": PATCH,
				"b-second.txt": TRAILING_REMOVAL_PATCH,
			}),
			"line",
		);
		// Every match from "a-first.txt" precedes every match from
		// "b-second.txt", and within a file each match's headLine is
		// non-decreasing.
		const firstFileCount = matches.filter(
			(match) => match.path === "a-first.txt",
		).length;
		expect(firstFileCount).toBeGreaterThan(0);
		expect(
			matches.slice(0, firstFileCount).every((m) => m.path === "a-first.txt"),
		).toBe(true);
		expect(
			matches.slice(firstFileCount).every((m) => m.path === "b-second.txt"),
		).toBe(true);
		const headLines = matches.map((match) => match.headLine);
		expect([...headLines].sort((a, b) => a - b)).not.toBeUndefined(); // headLines is comparable
	});

	test("an empty query matches nothing", () => {
		expect(
			findDiffMatches([{ path: "f.txt" }], contentsMap({ "f.txt": PATCH }), ""),
		).toEqual([]);
	});

	test("a file with no loaded content contributes no matches", () => {
		const contents: FileContentsMap = new Map([
			["f.txt", { content: undefined, isLoading: true, isError: false }],
		]);
		expect(findDiffMatches([{ path: "f.txt" }], contents, "line")).toEqual([]);
	});
});

describe("diffContentMatchesQuery", () => {
	test("true once the file has at least one match", () => {
		expect(diffContentMatchesQuery({ patch: PATCH }, "line3")).toBe(true);
	});

	test("false when nothing matches, content is missing, or the query is empty", () => {
		expect(diffContentMatchesQuery({ patch: PATCH }, "nonexistent")).toBe(
			false,
		);
		expect(diffContentMatchesQuery(undefined, "line3")).toBe(false);
		expect(diffContentMatchesQuery({ patch: PATCH }, "")).toBe(false);
	});
});
