import { describe, expect, test } from "bun:test";
import type { PullRequestStack } from "#/features/pull-request/data/pr-data";
import { deriveStackMerge } from "./pr-stack-merge";

const STACK: PullRequestStack = {
	number: 7,
	size: 3,
	baseRefName: "main",
	position: 3,
	entries: [
		{
			position: 1,
			number: 41,
			title: "First",
			headRefName: "stack/one",
			baseRefName: "main",
			state: "OPEN",
			isDraft: false,
		},
		{
			position: 2,
			number: 42,
			title: "Second",
			headRefName: "stack/two",
			baseRefName: "stack/one",
			state: "MERGED",
			isDraft: false,
		},
		{
			position: 3,
			number: 43,
			title: "Third",
			headRefName: "stack/three",
			baseRefName: "stack/two",
			state: "OPEN",
			isDraft: false,
		},
	],
};

describe("deriveStackMerge", () => {
	test("counts unmerged layers through the current PR", () => {
		expect(deriveStackMerge(STACK, 43)).toEqual({ count: 2 });
	});

	test("keeps the regular merge when the current PR is the only unmerged layer", () => {
		expect(
			deriveStackMerge(
				{
					...STACK,
					entries: STACK.entries.map((entry) => ({
						...entry,
						state: "MERGED" as const,
					})),
				},
				43,
			),
		).toBeNull();
	});

	test("returns no stack merge for an absent stack or unknown PR", () => {
		expect(deriveStackMerge(null, 43)).toBeNull();
		expect(deriveStackMerge(STACK, 99)).toBeNull();
	});
});
