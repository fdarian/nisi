import { describe, expect, test } from "bun:test";
import { editorUrl, encodeEditorPath } from "./editor-url";

describe("encodeEditorPath", () => {
	test("keeps separators and unreserved characters", () => {
		expect(encodeEditorPath("/Users/me/code/a-b_c.d~e")).toBe(
			"/Users/me/code/a-b_c.d~e",
		);
	});

	test("encodes spaces and reserved characters, uppercase hex", () => {
		expect(encodeEditorPath("/a b/c#d?e!(f)*'")).toBe(
			"/a%20b/c%23d%3Fe%21%28f%29%2A%27",
		);
	});

	test("encodes non-ASCII as UTF-8 bytes", () => {
		expect(encodeEditorPath("/repos/café")).toBe("/repos/caf%C3%A9");
	});
});

describe("editorUrl", () => {
	test("builds <scheme>://file/<encoded path>", () => {
		expect(editorUrl("vscode", "/tmp/my repo")).toBe(
			"vscode://file//tmp/my%20repo",
		);
	});
});
