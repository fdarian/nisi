import { describe, expect, test } from "bun:test";
import { changedLineRanges, validateCoverage } from "../src/coverage.ts";
import type { ReferenceBlock } from "../src/schema.ts";

describe("changedLineRanges", () => {
	test("collects added lines as head-file ranges, ignoring context", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,2 +1,3 @@",
			" line1",
			"+line2",
			" line3",
			"",
		].join("\n");

		expect(changedLineRanges(patch)).toEqual([{ startLine: 2, endLine: 2 }]);
	});

	test("merges a contiguous run of added lines into one range", () => {
		const patch = [
			"@@ -1,2 +1,4 @@",
			" line1",
			"+line2",
			"+line3",
			"+line4",
			" line5",
			"",
		].join("\n");

		expect(changedLineRanges(patch)).toEqual([{ startLine: 2, endLine: 4 }]);
	});

	test("produces no ranges for a purely-deleted hunk (nothing exists in head to reference)", () => {
		const patch = ["@@ -1,3 +0,0 @@", "-line1", "-line2", "-line3", ""].join(
			"\n",
		);
		expect(changedLineRanges(patch)).toEqual([]);
	});

	test("splits two separate added runs within one hunk", () => {
		const patch = [
			"@@ -1,3 +1,5 @@",
			"+top",
			" middle1",
			" middle2",
			"+bottom1",
			"+bottom2",
			"",
		].join("\n");

		expect(changedLineRanges(patch)).toEqual([
			{ startLine: 1, endLine: 1 },
			{ startLine: 4, endLine: 5 },
		]);
	});

	test("accumulates ranges across multiple hunks", () => {
		const patch = [
			"@@ -1,1 +1,2 @@",
			" line1",
			"+line2",
			"@@ -10,1 +11,2 @@",
			" line11",
			"+line12",
			"",
		].join("\n");

		expect(changedLineRanges(patch)).toEqual([
			{ startLine: 2, endLine: 2 },
			{ startLine: 12, endLine: 12 },
		]);
	});

	test("ignores a trailing 'no newline at end of file' marker", () => {
		const patch = [
			"@@ -1,1 +1,2 @@",
			" line1",
			"+line2",
			"\\ No newline at end of file",
		].join("\n");
		expect(changedLineRanges(patch)).toEqual([{ startLine: 2, endLine: 2 }]);
	});
});

const block = (
	id: string,
	path: string,
	startLine: number,
	endLine: number,
): ReferenceBlock => ({
	id,
	label: id,
	locations: [{ path, startLine, endLine }],
});

describe("validateCoverage", () => {
	test("passes when every changed line is claimed", () => {
		const changed = new Map([["a.ts", [{ startLine: 1, endLine: 5 }]]]);
		const result = validateCoverage(changed, [block("r1", "a.ts", 1, 5)]);
		expect(result).toEqual({ ok: true });
	});

	test("passes when locations across several blocks together cover the range", () => {
		const changed = new Map([["a.ts", [{ startLine: 1, endLine: 5 }]]]);
		const result = validateCoverage(changed, [
			block("r1", "a.ts", 1, 2),
			block("r2", "a.ts", 3, 5),
		]);
		expect(result).toEqual({ ok: true });
	});

	test("reports a missing file entirely", () => {
		const changed = new Map([
			["a.ts", [{ startLine: 1, endLine: 2 }]],
			["b.ts", [{ startLine: 1, endLine: 3 }]],
		]);
		const result = validateCoverage(changed, [block("r1", "a.ts", 1, 2)]);
		expect(result).toEqual({
			ok: false,
			gaps: [{ path: "b.ts", missingRanges: [{ startLine: 1, endLine: 3 }] }],
		});
	});

	test("reports a missing line range within an otherwise-covered file", () => {
		const changed = new Map([["a.ts", [{ startLine: 1, endLine: 10 }]]]);
		const result = validateCoverage(changed, [block("r1", "a.ts", 1, 4)]);
		expect(result).toEqual({
			ok: false,
			gaps: [{ path: "a.ts", missingRanges: [{ startLine: 5, endLine: 10 }] }],
		});
	});

	test("reports a gap sandwiched between two covered ranges", () => {
		const changed = new Map([["a.ts", [{ startLine: 1, endLine: 10 }]]]);
		const result = validateCoverage(changed, [
			block("r1", "a.ts", 1, 3),
			block("r2", "a.ts", 8, 10),
		]);
		expect(result).toEqual({
			ok: false,
			gaps: [{ path: "a.ts", missingRanges: [{ startLine: 4, endLine: 7 }] }],
		});
	});

	test("a file with no changed-line ranges (e.g. a deletion) needs no coverage", () => {
		const changed = new Map([["deleted.ts", []]]);
		const result = validateCoverage(changed, []);
		expect(result).toEqual({ ok: true });
	});
});
