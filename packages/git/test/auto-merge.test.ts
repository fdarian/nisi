import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
	decodeMergeabilityView,
	decodeRepoMergeMethodsView,
} from "../src/github/gh/merge.ts";

const pr = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "BLOCKED",
	isDraft: false,
};
const repo = {
	mergeCommitAllowed: true,
	squashMergeAllowed: true,
	rebaseMergeAllowed: false,
};

describe("auto-merge decoding", () => {
	test("decodes a null request", async () => {
		const status = await Effect.runPromise(
			decodeMergeabilityView(
				"gh pr view",
				JSON.stringify({ ...pr, autoMergeRequest: null }),
			),
		);
		expect(status.autoMerge).toBeNull();
	});
	for (const method of ["MERGE", "SQUASH", "REBASE"] as const) {
		test(`decodes ${method}`, async () => {
			const status = await Effect.runPromise(
				decodeMergeabilityView(
					"gh pr view",
					JSON.stringify({ ...pr, autoMergeRequest: { mergeMethod: method } }),
				),
			);
			expect(status.autoMerge?.method === method.toLowerCase()).toBe(true);
		});
	}
	for (const allowed of [true, false]) {
		test(`decodes autoMergeAllowed=${allowed}`, async () => {
			const settings = await Effect.runPromise(
				decodeRepoMergeMethodsView(
					"gh repo view",
					JSON.stringify({ ...repo, autoMergeAllowed: allowed }),
				),
			);
			expect(settings.autoMergeAllowed).toBe(allowed);
		});
	}
	test("rejects missing or invalid auto-merge fields", async () => {
		for (const value of [
			pr,
			{ ...pr, autoMergeRequest: { mergeMethod: "INVALID" } },
		]) {
			expect(
				Exit.isFailure(
					await Effect.runPromiseExit(
						decodeMergeabilityView("gh pr view", JSON.stringify(value)),
					),
				),
			).toBe(true);
		}
		for (const value of [repo, { ...repo, autoMergeAllowed: "true" }]) {
			expect(
				Exit.isFailure(
					await Effect.runPromiseExit(
						decodeRepoMergeMethodsView("gh repo view", JSON.stringify(value)),
					),
				),
			).toBe(true);
		}
	});
});
