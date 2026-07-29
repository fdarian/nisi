import { describe, expect, test } from "bun:test";
import { resolveReviewState } from "../src/resolve-review.ts";

describe("resolveReviewState", () => {
	test("finds state under the current path", () => {
		const states = new Map([
			["src/new-name.ts", { viewed: true, snapshotHash: "abc", viewedAt: 1 }],
		]);
		expect(resolveReviewState(states, "src/new-name.ts", undefined)).toEqual({
			viewed: true,
			snapshotHash: "abc",
			viewedAt: 1,
		});
	});

	test("falls back to the old path when the current path has no state — a rename", () => {
		const states = new Map([
			["src/old-name.ts", { viewed: true, snapshotHash: "abc", viewedAt: 1 }],
		]);
		expect(
			resolveReviewState(states, "src/new-name.ts", "src/old-name.ts"),
		).toEqual({ viewed: true, snapshotHash: "abc", viewedAt: 1 });
	});

	test("prefers the current path's state over the old path's when both exist", () => {
		const states = new Map([
			["src/old-name.ts", { viewed: true, snapshotHash: "old", viewedAt: 1 }],
			["src/new-name.ts", { viewed: true, snapshotHash: "new", viewedAt: 2 }],
		]);
		expect(
			resolveReviewState(states, "src/new-name.ts", "src/old-name.ts"),
		).toEqual({ viewed: true, snapshotHash: "new", viewedAt: 2 });
	});

	test("returns null when neither path has state", () => {
		const states = new Map();
		expect(
			resolveReviewState(states, "src/new-name.ts", "src/old-name.ts"),
		).toBeNull();
	});
});
