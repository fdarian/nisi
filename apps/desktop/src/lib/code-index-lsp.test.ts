import { describe, expect, test } from "bun:test";
import { codeIndexLspStatusForControl } from "./code-index-lsp";

describe("codeIndexLspStatusForControl", () => {
	test("shows starting while the start request is pending", () => {
		expect(
			codeIndexLspStatusForControl({ status: "off", error: null }, true),
		).toBe("starting");
	});

	test("uses the pool status when no start request is pending", () => {
		expect(
			codeIndexLspStatusForControl({ status: "on", error: null }, false),
		).toBe("on");
		expect(codeIndexLspStatusForControl(undefined, false)).toBe("off");
	});
});
