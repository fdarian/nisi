import { describe, expect, test } from "bun:test";
import {
	codeIndexLspIntentForStatus,
	sessionIdsForCodeIndexLspStatus,
} from "./code-index-lsp-events";

describe("code-index LSP status events", () => {
	test("matches every session sharing the event's root", () => {
		expect(
			sessionIdsForCodeIndexLspStatus(
				[
					{ id: "one", repoRoot: "/repo" },
					{ id: "two", repoRoot: "/other" },
					{ id: "three", repoRoot: "/repo" },
				],
				{
					type: "code-index-lsp-status-changed",
					repoRoot: "/repo",
					status: { status: "off", error: null },
				},
			),
		).toEqual(["one", "three"]);
	});

	test("only off disables the session intent", () => {
		expect(codeIndexLspIntentForStatus("starting")).toBe(true);
		expect(codeIndexLspIntentForStatus("on")).toBe(true);
		expect(codeIndexLspIntentForStatus("off")).toBe(false);
	});
});
