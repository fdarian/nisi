import { describe, expect, test } from "bun:test";
import { isHeadMovedRejection } from "../scheduled-merge.ts";

describe("isHeadMovedRejection", () => {
	for (const detail of [
		"GraphQL: Head branch was modified. Review and try the merge again. (mergePullRequest)",
		"the provided sha does not match head sha: abc123",
		"Head SHA changed",
		"head commit has changed",
		"HEAD COMMIT DOES NOT MATCH",
	]) {
		test(`recognizes ${detail}`, () =>
			expect(isHeadMovedRejection(detail)).toBe(true));
	}
	for (const detail of [
		"Required review missing",
		"Merge conflicts",
		"the provided sha is in an invalid format",
		"GitHub unavailable",
		"",
	]) {
		test(`does not classify unrelated rejection: ${detail}`, () =>
			expect(isHeadMovedRejection(detail)).toBe(false));
	}
});
