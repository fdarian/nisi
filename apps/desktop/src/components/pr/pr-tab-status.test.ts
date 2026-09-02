import { describe, expect, test } from "bun:test";
import type { PullRequestCheck, PullRequestMergeStatus } from "#/lib/pr-data";
import { derivePrTabStatus } from "./pr-tab-status.ts";

/** `usePullRequestMergeStatus`'s default OPEN/CLEAN/mergeable shape — each test overrides only the fields it's about. */
function mergeStatus(
	overrides: Partial<PullRequestMergeStatus> = {},
): PullRequestMergeStatus {
	return {
		state: "OPEN",
		mergeable: "MERGEABLE",
		mergeStateStatus: "CLEAN",
		isDraft: false,
		allowedMethods: ["merge"],
		defaultMethod: "merge",
		...overrides,
	};
}

function check(status: PullRequestCheck["status"]): PullRequestCheck {
	return { name: "build", status };
}

describe("derivePrTabStatus", () => {
	test("undefined merge status and checks fall through to default", () => {
		expect(derivePrTabStatus(undefined, undefined)).toBe("default");
	});

	test("MERGED wins regardless of checks", () => {
		expect(
			derivePrTabStatus(mergeStatus({ state: "MERGED" }), [check("passing")]),
		).toBe("merged");
	});

	test("MERGED wins even over a stray running check", () => {
		expect(
			derivePrTabStatus(mergeStatus({ state: "MERGED" }), [check("running")]),
		).toBe("merged");
	});

	test("a running check outranks ready-to-merge", () => {
		expect(
			derivePrTabStatus(mergeStatus(), [check("passing"), check("running")]),
		).toBe("ci-running");
	});

	test("MERGEABLE + CLEAN with no running checks is ready", () => {
		expect(derivePrTabStatus(mergeStatus(), [check("passing")])).toBe("ready");
	});

	test("MERGEABLE + CLEAN with checks still undefined is ready", () => {
		expect(derivePrTabStatus(mergeStatus(), undefined)).toBe("ready");
	});

	test("CONFLICTING falls through to default", () => {
		expect(
			derivePrTabStatus(
				mergeStatus({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }),
				[check("passing")],
			),
		).toBe("default");
	});

	test("mergeable UNKNOWN falls through to default", () => {
		expect(
			derivePrTabStatus(mergeStatus({ mergeable: "UNKNOWN" }), undefined),
		).toBe("default");
	});

	test("MERGEABLE but BLOCKED falls through to default", () => {
		expect(
			derivePrTabStatus(mergeStatus({ mergeStateStatus: "BLOCKED" }), []),
		).toBe("default");
	});

	test("a failing check with no running check falls through to default, not ci-running", () => {
		expect(
			derivePrTabStatus(mergeStatus({ mergeable: "UNKNOWN" }), [
				check("failing"),
			]),
		).toBe("default");
	});

	test("draft PR (mergeable UNKNOWN while drafted) falls through to default", () => {
		expect(
			derivePrTabStatus(
				mergeStatus({
					isDraft: true,
					mergeable: "UNKNOWN",
					mergeStateStatus: "DRAFT",
				}),
				undefined,
			),
		).toBe("default");
	});

	test("CLOSED (not merged) falls through to default", () => {
		// GitHub stops computing `mergeable` once a PR is no longer open, so a
		// real CLOSED status always carries "UNKNOWN" — matching that here
		// rather than the fixture's default MERGEABLE/CLEAN.
		expect(
			derivePrTabStatus(
				mergeStatus({ state: "CLOSED", mergeable: "UNKNOWN" }),
				undefined,
			),
		).toBe("default");
	});

	test("empty checks array is not a running check", () => {
		expect(derivePrTabStatus(mergeStatus(), [])).toBe("ready");
	});
});
