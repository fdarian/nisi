import { describe, expect, test } from "bun:test";
import { derivePrStatus } from "./pr-status";

const ready = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
};

describe("derivePrStatus", () => {
	test("unknown input defaults", () =>
		expect(derivePrStatus({})).toBe("default"));
	test("merged outranks conflicts, draft and CI", () =>
		expect(
			derivePrStatus({
				...ready,
				state: "MERGED",
				mergeable: "CONFLICTING",
				isDraft: true,
				ciRunning: true,
			}),
		).toBe("merged"));
	test("either conflict signal outranks draft and CI", () => {
		expect(
			derivePrStatus({
				...ready,
				mergeable: "CONFLICTING",
				isDraft: true,
				ciRunning: true,
			}),
		).toBe("conflicts");
		expect(derivePrStatus({ ...ready, mergeStateStatus: "DIRTY" })).toBe(
			"conflicts",
		);
	});
	test("draft outranks CI and ready", () =>
		expect(derivePrStatus({ ...ready, isDraft: true, ciRunning: true })).toBe(
			"draft",
		));
	test("CI outranks ready", () =>
		expect(derivePrStatus({ ...ready, ciRunning: true })).toBe("ci-running"));
	test("mergeable and clean is ready even with unknown checks", () =>
		expect(derivePrStatus(ready)).toBe("ready"));
	test("other merge states default", () => {
		expect(derivePrStatus({ ...ready, mergeable: "UNKNOWN" })).toBe("default");
		expect(derivePrStatus({ ...ready, mergeStateStatus: "BLOCKED" })).toBe(
			"default",
		);
		expect(
			derivePrStatus({ ...ready, state: "CLOSED", mergeable: "UNKNOWN" }),
		).toBe("default");
	});
});
