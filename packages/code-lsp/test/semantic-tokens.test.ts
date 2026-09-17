import { describe, expect, test } from "bun:test";
import {
	decodeSemanticTokens,
	type SemanticTokensLegend,
} from "../src/semantic-tokens.ts";

const legend: SemanticTokensLegend = {
	tokenTypes: ["function", "parameter", "variable"],
	tokenModifiers: ["declaration", "readonly", "async"],
};

describe("decodeSemanticTokens", () => {
	test("decodes a single token at the buffer's start", () => {
		// deltaLine=2, deltaStartChar=4, length=5, tokenType=0 ("function"), modifiers=0b001 ("declaration")
		const data = [2, 4, 5, 0, 0b001];
		expect(decodeSemanticTokens(data, legend)).toEqual([
			{
				range: {
					start: { line: 2, character: 4 },
					end: { line: 2, character: 9 },
				},
				tokenType: "function",
				tokenModifiers: ["declaration"],
			},
		]);
	});

	test("deltaStartChar is relative to the previous token when deltaLine is 0 (same line)", () => {
		const data = [
			0,
			10,
			4,
			0,
			0, // line 0, char 10..14: "function"
			0,
			5,
			3,
			1,
			0, // same line, +5 from previous start -> char 15..18: "parameter"
		];
		expect(decodeSemanticTokens(data, legend)).toEqual([
			{
				range: {
					start: { line: 0, character: 10 },
					end: { line: 0, character: 14 },
				},
				tokenType: "function",
				tokenModifiers: [],
			},
			{
				range: {
					start: { line: 0, character: 15 },
					end: { line: 0, character: 18 },
				},
				tokenType: "parameter",
				tokenModifiers: [],
			},
		]);
	});

	test("deltaStartChar is absolute on a new line (deltaLine > 0)", () => {
		const data = [
			1,
			8,
			4,
			0,
			0, // line 1, char 8..12
			1,
			2,
			3,
			2,
			0, // line 2, char 2..5 -- NOT 8+2, since deltaLine !== 0
		];
		const tokens = decodeSemanticTokens(data, legend);
		expect(tokens[1]?.range).toEqual({
			start: { line: 2, character: 2 },
			end: { line: 2, character: 5 },
		});
	});

	test("decodes a bitset spanning multiple modifiers", () => {
		// bits 0 and 2 set -> "declaration" and "async"
		const data = [0, 0, 1, 2, 0b101];
		expect(decodeSemanticTokens(data, legend)[0]?.tokenModifiers).toEqual([
			"declaration",
			"async",
		]);
	});

	test("no modifiers set decodes to an empty array", () => {
		const data = [0, 0, 1, 2, 0];
		expect(decodeSemanticTokens(data, legend)[0]?.tokenModifiers).toEqual([]);
	});

	test("empty data decodes to an empty array", () => {
		expect(decodeSemanticTokens([], legend)).toEqual([]);
	});

	test("throws when data length isn't a multiple of 5", () => {
		expect(() => decodeSemanticTokens([0, 0, 1, 0], legend)).toThrow();
	});

	test("throws on a token type index outside the legend", () => {
		expect(() => decodeSemanticTokens([0, 0, 1, 99, 0], legend)).toThrow();
	});
});
