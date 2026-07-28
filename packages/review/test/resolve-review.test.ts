import { describe, expect, test } from "bun:test";
import { resolveReviewState } from "../src/resolve-review.ts";

describe("resolveReviewState", () => {
	test("finds state under the current path", () => {
		const states = new Map([
			["src/new-name.ts", { viewed: true, snapshotHash: "abc" }],
		]);
		expect(resolveReviewState(states, "src/new-name.ts", undefined)).toEqual({
			viewed: true,
			snapshotHash: "abc",
		});
	});

	test("falls back to the old path when the current path has no state — a rename", () => {
		const states = new Map([
			["src/old-name.ts", { viewed: true, snapshotHash: "abc" }],
		]);
		expect(
			resolveReviewState(states, "src/new-name.ts", "src/old-name.ts"),
		).toEqual({ viewed: true, snapshotHash: "abc" });
	});

	test("prefers the current path's state over the old path's when both exist", () => {
		const states = new Map([
			["src/old-name.ts", { viewed: true, snapshotHash: "old" }],
			["src/new-name.ts", { viewed: true, snapshotHash: "new" }],
		]);
		expect(
			resolveReviewState(states, "src/new-name.ts", "src/old-name.ts"),
		).toEqual({ viewed: true, snapshotHash: "new" });
	});

	test("returns null when neither path has state", () => {
		const states = new Map();
		expect(
			resolveReviewState(states, "src/new-name.ts", "src/old-name.ts"),
		).toBeNull();
	});
});
