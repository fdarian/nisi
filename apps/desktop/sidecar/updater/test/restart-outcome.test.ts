import { describe, expect, test } from "bun:test";
import { reconcileRestartOutcome } from "../restart-outcome.ts";

describe("reconcileRestartOutcome", () => {
	test("flags a stalled upgrade when the installed version didn't move", () => {
		expect(
			reconcileRestartOutcome({
				versionBefore: "0.3.1",
				versionAfter: "0.3.1",
				exitCode: 0,
			}),
		).toEqual({ kind: "upgrade-stalled", version: "0.3.1", exitCode: 0 });
	});

	test("still flags a stall when brew upgrade exited nonzero and nothing moved", () => {
		expect(
			reconcileRestartOutcome({
				versionBefore: "0.3.1",
				versionAfter: "0.3.1",
				exitCode: 1,
			}),
		).toEqual({ kind: "upgrade-stalled", version: "0.3.1", exitCode: 1 });
	});

	test("reads as no-op when the installed version moved", () => {
		expect(
			reconcileRestartOutcome({
				versionBefore: "0.3.1",
				versionAfter: "0.3.2",
				exitCode: 0,
			}),
		).toEqual({ kind: "none" });
	});
});
