import { expect, test } from "bun:test";
import { diffStat } from "./diff-stat";

const files = [
	{ additions: 3, deletions: 1 },
	{ additions: 10, deletions: 0 },
];

test("sums additions and deletions once the files have loaded", () => {
	expect(diffStat({ files, isLoading: false, error: null })).toEqual({
		status: "ready",
		additions: 13,
		deletions: 1,
	});
});

test("an empty diff is a real +0 -0, not loading", () => {
	expect(diffStat({ files: [], isLoading: false, error: null })).toEqual({
		status: "ready",
		additions: 0,
		deletions: 0,
	});
});

test("never reports counts while the files are still loading", () => {
	expect(diffStat({ files: [], isLoading: true, error: null })).toEqual({
		status: "loading",
	});
});

test("an error is unavailable rather than +0 -0", () => {
	expect(
		diffStat({ files: [], isLoading: false, error: new Error("boom") }),
	).toEqual({ status: "unavailable" });
});
