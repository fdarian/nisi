import { describe, expect, test } from "bun:test";
import {
	codeIndexDisplayedLine,
	codeIndexReferenceTarget,
	codeIndexTargetLength,
} from "#/lib/code-index-navigation";

describe("code-index reference targets", () => {
	test("preserves the LSP location and converts its line for CodeView", () => {
		const target = codeIndexReferenceTarget("src/example.ts", {
			line: 194,
			charStart: 7,
			charEnd: 24,
		});

		expect(target).toEqual({
			path: "src/example.ts",
			line: 194,
			charStart: 7,
			charEnd: 24,
		});
		expect(codeIndexDisplayedLine(target)).toBe(195);
		expect(codeIndexTargetLength(target)).toBe(17);
	});

	test("rejects an invalid negative range length", () => {
		const target = {
			path: "src/example.ts",
			line: 0,
			charStart: 4,
			charEnd: 2,
		};

		expect(codeIndexTargetLength(target)).toBeUndefined();
	});
});
