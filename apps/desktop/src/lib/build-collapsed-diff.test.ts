import { describe, expect, test } from "bun:test";
import { buildCollapsedFileDiff } from "./build-collapsed-diff.ts";
import { parsePatchHunks } from "./diff-hunk-slicing.ts";
import type { ReviewRange } from "./pr-data.ts";

/**
 * Real `git diff -U1` output (base → head, see module doc for why a
 * mid-hunk split matters): two hunks, the first spanning head lines 2-5
 * (`line2`, `line3-changed`, `line3b`, `line4`), the second head lines
 * 10-12 (`line9`, `line10-changed`, `line11`).
 */
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
@@ -9,3 +10,3 @@ line8
 line9
-line10
+line10-changed
 line11
`;

const FILE_SOURCE: ReviewRange["reviewedVia"] = { kind: "file" };

describe("buildCollapsedFileDiff", () => {
	test("splits a hunk mid-way and re-derives correct @@ offsets for both surviving pieces", () => {
		// Head lines 3-4 ("line3-changed", "line3b") reviewed — splits hunk 1
		// into a kept line before and a kept line after, both inside what was
		// one hunk.
		const ranges: ReviewRange[] = [
			{
				startLine: 3,
				endLine: 4,
				status: "reviewed",
				reviewedVia: FILE_SOURCE,
			},
		];

		const result = buildCollapsedFileDiff(PATCH, ranges);
		if (result?.kind !== "partial")
			throw new Error("expected a partial collapse");

		// Every surviving hunk's header must describe exactly the lines in its
		// own body — re-parse the produced patch with the same primitive
		// `serializeSubHunk` output is meant to round-trip through, and check
		// each hunk's declared start/count against what's actually there.
		const { hunks } = parsePatchHunks(result.patch);
		expect(hunks).toHaveLength(3);

		// "line2" survives alone: unchanged old/new position (old2, new2).
		expect(hunks[0]).toMatchObject({ oldStart: 2, newStart: 2 });
		expect(hunks[0]?.lines).toHaveLength(1);

		// "line4" survives alone: two head-only lines were dropped ahead of it
		// (line3-changed, line3b), so its new position shifted from old4 to
		// new5 — this is exactly the kind of offset a naive re-slice could get
		// wrong.
		expect(hunks[1]).toMatchObject({ oldStart: 4, newStart: 5 });
		expect(hunks[1]?.lines).toHaveLength(1);

		// Hunk 2 wasn't touched by the reviewed range at all, so it survives
		// byte-for-byte with its original coordinates.
		expect(hunks[2]).toMatchObject({ oldStart: 9, newStart: 10 });
		expect(hunks[2]?.lines).toHaveLength(4);

		// The gap anchors on the next surviving head line (line4, head line 5)
		// and reports exactly the 2 dropped lines.
		expect(result.gaps).toEqual([
			{ anchorLine: 5, lineCount: 2, source: { kind: "file" } },
		]);
	});

	test("a different reviewed range on the identical input patch produces different collapsed text", () => {
		// This is the fact `diff-pane.tsx`'s @pierre/diffs cache key has to
		// respect: the same `patch`/`file.fingerprint` can legitimately collapse
		// to different bodies depending on which ranges are currently reviewed
		// (e.g. before vs. after clicking Reviewed). A cache key derived from
		// `file.fingerprint` alone can't distinguish these two renders.
		const rangesA: ReviewRange[] = [
			{
				startLine: 3,
				endLine: 4,
				status: "reviewed",
				reviewedVia: FILE_SOURCE,
			},
		];
		const rangesB: ReviewRange[] = [
			{
				startLine: 11,
				endLine: 11,
				status: "reviewed",
				reviewedVia: FILE_SOURCE,
			},
		];

		const resultA = buildCollapsedFileDiff(PATCH, rangesA);
		const resultB = buildCollapsedFileDiff(PATCH, rangesB);
		if (resultA?.kind !== "partial" || resultB?.kind !== "partial") {
			throw new Error("expected both collapses to be partial");
		}

		expect(resultA.patch).not.toBe(resultB.patch);
	});

	test("returns undefined when nothing is reviewed yet", () => {
		const ranges: ReviewRange[] = [
			{ startLine: 3, endLine: 4, status: "new", reviewedVia: null },
		];
		expect(buildCollapsedFileDiff(PATCH, ranges)).toBeUndefined();
	});
});
