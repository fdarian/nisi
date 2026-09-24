import { expect, test } from "bun:test";
import { selectionHeadRange } from "./selection-head-range";

test("collects head rows across a mixed deletion and addition drag", () => {
	expect(
		selectionHeadRange(
			[
				{ line: 11, side: "additions" },
				{ line: 12, side: "deletions" },
				{ line: 13, side: "deletions" },
				{ line: 12, side: "additions" },
				{ line: 13, side: "additions" },
			],
			40,
		),
	).toEqual({ startLine: 10, endLine: 14 });
});

test("does not claim old-side numbers for a deletion-only selection", () => {
	expect(
		selectionHeadRange([
			{ line: 20, side: "deletions" },
			{ line: 21, side: "deletions" },
		]),
	).toBeUndefined();
});

test("normalizes reverse drags and empty selections", () => {
	expect(
		selectionHeadRange([
			{ line: 30, side: "additions" },
			{ line: 12, side: "additions" },
		]),
	).toEqual({ startLine: 12, endLine: 30 });
	expect(selectionHeadRange([])).toBeUndefined();
});

test("caps deletion flanks at the HEAD file boundaries", () => {
	expect(
		selectionHeadRange(
			[
				{ line: 1, side: "deletions" },
				{ line: 1, side: "additions" },
			],
			1,
		),
	).toEqual({ startLine: 1, endLine: 1 });
});
