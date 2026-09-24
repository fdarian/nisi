import { expect, test } from "bun:test";
import type {
	FileChange,
	FileContent,
} from "#/features/pull-request/data/pr-data";
import { buildFileDiff } from "./build-file-diff";

test("reviewed baseline changes Pierre's diff cache identity with an unchanged file fingerprint", () => {
	const file: FileChange = {
		path: "example.ts",
		status: "modified",
		category: "implementation",
		additions: 2,
		deletions: 0,
		fingerprint: "same-head",
		binary: false,
		review: null,
	};
	const base = "first\nlast\n";
	const head = "first\nreviewed\nlast\nother change\n";
	const content: FileContent = {
		patch: "+reviewed\n+other change\n",
		oldContent: base,
		newContent: head,
		truncated: false,
		review: null,
	};
	const before = buildFileDiff(file, content);
	const after = buildFileDiff(file, {
		...content,
		patch: "+other change\n",
		oldContent: "first\nreviewed\nlast\n",
		review: { baselineKind: "reviewed", changedSinceReview: true, ranges: [] },
	});
	expect(before?.cacheKey).toBeDefined();
	expect(after?.cacheKey).toBeDefined();
	expect(after?.cacheKey).not.toBe(before?.cacheKey);
	expect(
		before?.hunks.reduce((count, hunk) => count + hunk.additionLines, 0),
	).toBe(2);
	expect(
		after?.hunks.reduce((count, hunk) => count + hunk.additionLines, 0),
	).toBe(1);
});
