import { describe, expect, test } from "bun:test";
import { codeIndexLspStatusForControl } from "./code-index-lsp";

describe("codeIndexLspStatusForControl", () => {
	test("shows the pushed starting state", () => {
		expect(
			codeIndexLspStatusForControl({ status: "starting", error: null }),
		).toBe("starting");
	});

	test("uses the pool status when no start request is pending", () => {
		expect(codeIndexLspStatusForControl({ status: "on", error: null })).toBe(
			"on",
		);
		expect(codeIndexLspStatusForControl(undefined)).toBe("off");
	});
});
