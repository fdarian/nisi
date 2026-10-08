import { describe, expect, test } from "bun:test";
import type { PullRequestCheck, PullRequestMergeability } from "@repo/git";
import { decideScheduledMerge } from "../scheduled-merge.ts";

const clean: PullRequestMergeability = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
	headRefOid: "head",
	baseRefOid: "base",
};
const passing: readonly PullRequestCheck[] = [
	{ name: "Tests", status: "passing" },
	{ name: "Lint", status: "skipped" },
];

describe("scheduled merge decision", () => {
	for (const state of ["CLOSED", "MERGED"] as const) {
		test(`cancels ${state} before checking CI`, () => {
			expect(
				decideScheduledMerge({ ...clean, state }, [
					{ name: "Tests", status: "failing" },
				]).outcome,
			).toBe("cancelled");
		});
	}
	test("fails with all failing check names", () => {
		expect(
			decideScheduledMerge(clean, [
				{ name: "Tests", status: "failing" },
				{ name: "Lint", status: "failing" },
				{ name: "Build", status: "running" },
			]),
		).toEqual({ outcome: "failed", reason: "Checks failed: Tests, Lint" });
	});
	test("fails conflicts even with pending CI", () => {
		expect(
			decideScheduledMerge({ ...clean, mergeStateStatus: "DIRTY" }, [
				{ name: "CI", status: "pending" },
			]),
		).toEqual({ outcome: "failed", reason: "Merge conflicts" });
	});
	for (const status of ["pending", "running", "awaiting_approval"] as const) {
		test(`waits for ${status} checks`, () => {
			expect(
				decideScheduledMerge(clean, [{ name: "CI", status }]).outcome,
			).toBe("wait");
		});
	}
	for (const mergeStateStatus of [
		"BLOCKED",
		"BEHIND",
		"UNSTABLE",
		"UNKNOWN",
		"DRAFT",
	] as const) {
		test(`waits while ${mergeStateStatus}`, () => {
			expect(
				decideScheduledMerge({ ...clean, mergeStateStatus }, passing).outcome,
			).toBe("wait");
		});
	}
	for (const mergeStateStatus of ["CLEAN", "HAS_HOOKS"] as const) {
		test(`merges when ${mergeStateStatus} with passing or skipped checks`, () => {
			expect(
				decideScheduledMerge({ ...clean, mergeStateStatus }, passing).outcome,
			).toBe("merge");
		});
	}
	test("merges a clean PR with no checks", () => {
		expect(decideScheduledMerge(clean, []).outcome).toBe("merge");
	});
	test("waits for unknown mergeability, conflicts, and drafts", () => {
		expect(
			decideScheduledMerge({ ...clean, mergeable: "UNKNOWN" }, passing).outcome,
		).toBe("wait");
		expect(
			decideScheduledMerge({ ...clean, mergeable: "CONFLICTING" }, passing)
				.outcome,
		).toBe("wait");
		expect(
			decideScheduledMerge({ ...clean, isDraft: true }, passing).outcome,
		).toBe("wait");
	});
});
