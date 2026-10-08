import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
	decodeMergeabilityView,
	decodeRepoMergeMethodsView,
} from "../src/github/gh/merge.ts";

describe("merge status decoding", () => {
	test("does not require GitHub-native auto-merge fields", async () => {
		const status = {
			state: "OPEN",
			mergeable: "MERGEABLE",
			mergeStateStatus: "BLOCKED",
			isDraft: false,
			headRefOid: "0123456789abcdef0123456789abcdef01234567",
			baseRefOid: "89abcdef0123456789abcdef0123456789abcdef",
		} as const;
		expect(
			await Effect.runPromise(
				decodeMergeabilityView("gh pr view", JSON.stringify(status)),
			),
		).toEqual(status);
		const methods = {
			mergeCommitAllowed: true,
			squashMergeAllowed: false,
			rebaseMergeAllowed: true,
		};
		expect(
			await Effect.runPromise(
				decodeRepoMergeMethodsView("gh repo view", JSON.stringify(methods)),
			),
		).toEqual(methods);
	});
	test("rejects invalid status and missing repository settings", async () => {
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					decodeMergeabilityView(
						"gh pr view",
						JSON.stringify({ state: "INVALID" }),
					),
				),
			),
		).toBe(true);
		expect(
			Exit.isFailure(
				await Effect.runPromiseExit(
					decodeRepoMergeMethodsView(
						"gh repo view",
						JSON.stringify({ mergeCommitAllowed: true }),
					),
				),
			),
		).toBe(true);
	});
});
