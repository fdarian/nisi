import { describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { DocumentSchema, IndexSchema, SymbolRole } from "@scip-code/scip";
import { Effect } from "effect";
import {
	type CodeIndex,
	decodeIndex,
	decodeRange,
	definitionsOf,
	displayNameOf,
	documentationOf,
	hasDefinition,
	occurrencesInDocument,
	referenceCount,
	referencesOf,
	symbolAtPosition,
} from "../src/decode.ts";
import { symbolKeyOf } from "../src/symbol.ts";

describe("decodeRange", () => {
	test("decodes the 3-element single-line form, inferring endLine == startLine", () => {
		expect(decodeRange([4, 10, 20], "sym")).toEqual({
			startLine: 4,
			startChar: 10,
			endLine: 4,
			endChar: 20,
		});
	});

	test("decodes the 4-element multi-line form", () => {
		expect(decodeRange([4, 10, 6, 3], "sym")).toEqual({
			startLine: 4,
			startChar: 10,
			endLine: 6,
			endChar: 3,
		});
	});

	test("throws on any other length", () => {
		expect(() => decodeRange([1, 2], "sym")).toThrow();
		expect(() => decodeRange([1, 2, 3, 4, 5], "sym")).toThrow();
	});
});

const METHOD_SYMBOL = "scip-typescript npm mypackage 1.0.0 MyClass#myMethod().";

/**
 * A two-document synthetic index built the same way scip-typescript's real
 * output is shaped, small enough to hand-construct: `a.ts` defines
 * `MyClass#myMethod` and a `local 0`; `b.ts` references `MyClass#myMethod`
 * from a different file and defines its own, unrelated `local 0` — the
 * exact "two locals with the same raw id in different documents" case the
 * SCIP spec calls out.
 */
const buildFixtureIndex = (): Uint8Array => {
	const docA = create(DocumentSchema, {
		relativePath: "a.ts",
		occurrences: [
			{
				symbol: METHOD_SYMBOL,
				range: [0, 10, 20],
				symbolRoles: SymbolRole.Definition,
			},
			{
				symbol: METHOD_SYMBOL,
				range: [5, 4, 4, 12],
				symbolRoles: 0,
			},
			{
				symbol: "local 0",
				range: [2, 0, 5],
				symbolRoles: SymbolRole.Definition,
			},
		],
		symbols: [
			{ symbol: METHOD_SYMBOL, documentation: ["docs for myMethod"] },
			{ symbol: "local 0", documentation: [] },
		],
	});

	const docB = create(DocumentSchema, {
		relativePath: "b.ts",
		occurrences: [
			{
				symbol: "local 0",
				range: [0, 0, 3],
				symbolRoles: SymbolRole.Definition,
			},
			{
				symbol: METHOD_SYMBOL,
				range: [1, 0, 1, 5],
				symbolRoles: 0,
			},
		],
		symbols: [{ symbol: "local 0", documentation: [] }],
	});

	const index = create(IndexSchema, {
		metadata: { projectRoot: "file:///repo" },
		documents: [docA, docB],
	});

	return toBinary(IndexSchema, index);
};

const decode = (bytes: Uint8Array): Promise<CodeIndex> =>
	Effect.runPromise(decodeIndex(bytes));

describe("decodeIndex", () => {
	test("reports the project root and document count", async () => {
		const index = await decode(buildFixtureIndex());
		expect(index.projectRoot).toBe("file:///repo");
		expect(index.documentCount).toBe(2);
	});

	test("occurrencesInDocument returns every occurrence in reading order", async () => {
		const index = await decode(buildFixtureIndex());
		const occurrences = occurrencesInDocument(index, "a.ts");
		expect(occurrences).toBeDefined();
		expect(occurrences?.map((o) => o.range.startLine)).toEqual([0, 2, 5]);
	});

	test("occurrencesInDocument is undefined for a path outside the index", async () => {
		const index = await decode(buildFixtureIndex());
		expect(occurrencesInDocument(index, "missing.ts")).toBeUndefined();
	});

	describe("symbolAtPosition", () => {
		test("matches at the range's startChar (inclusive boundary)", async () => {
			const index = await decode(buildFixtureIndex());
			const occurrence = symbolAtPosition(index, "a.ts", 0, 10);
			expect(occurrence?.isDefinition).toBe(true);
		});

		test("does not match at the range's endChar (exclusive boundary)", async () => {
			const index = await decode(buildFixtureIndex());
			expect(symbolAtPosition(index, "a.ts", 0, 20)).toBeUndefined();
		});

		test("matches one character before endChar", async () => {
			const index = await decode(buildFixtureIndex());
			expect(symbolAtPosition(index, "a.ts", 0, 19)).toBeDefined();
		});

		test("does not match one character before startChar", async () => {
			const index = await decode(buildFixtureIndex());
			expect(symbolAtPosition(index, "a.ts", 0, 9)).toBeUndefined();
		});

		test("undefined off the line entirely", async () => {
			const index = await decode(buildFixtureIndex());
			expect(symbolAtPosition(index, "a.ts", 1, 0)).toBeUndefined();
		});
	});

	test("definitions and references partition by the Definition role bit", async () => {
		const index = await decode(buildFixtureIndex());
		const key = symbolKeyOf("a.ts", METHOD_SYMBOL);

		expect(definitionsOf(index, key)).toEqual([
			{
				path: "a.ts",
				range: { startLine: 0, startChar: 10, endLine: 0, endChar: 20 },
			},
		]);
		expect(referencesOf(index, key)).toEqual([
			{
				path: "a.ts",
				range: { startLine: 5, startChar: 4, endLine: 4, endChar: 12 },
			},
			{
				path: "b.ts",
				range: { startLine: 1, startChar: 0, endLine: 1, endChar: 5 },
			},
		]);
		expect(hasDefinition(index, key)).toBe(true);
		expect(referenceCount(index, key)).toBe(2);
	});

	test("two 'local 0's in different documents resolve to independent definitions", async () => {
		const index = await decode(buildFixtureIndex());
		const keyInA = symbolKeyOf("a.ts", "local 0");
		const keyInB = symbolKeyOf("b.ts", "local 0");

		expect(definitionsOf(index, keyInA)).toEqual([
			{
				path: "a.ts",
				range: { startLine: 2, startChar: 0, endLine: 2, endChar: 5 },
			},
		]);
		expect(definitionsOf(index, keyInB)).toEqual([
			{
				path: "b.ts",
				range: { startLine: 0, startChar: 0, endLine: 0, endChar: 3 },
			},
		]);
	});

	test("displayNameOf derives from the descriptor chain", async () => {
		const index = await decode(buildFixtureIndex());
		expect(displayNameOf(index, symbolKeyOf("a.ts", METHOD_SYMBOL))).toBe(
			"myMethod",
		);
	});

	test("documentationOf returns the symbol's documentation strings", async () => {
		const index = await decode(buildFixtureIndex());
		expect(documentationOf(index, symbolKeyOf("a.ts", METHOD_SYMBOL))).toEqual([
			"docs for myMethod",
		]);
	});

	test("documentationOf is empty for a symbol with none", async () => {
		const index = await decode(buildFixtureIndex());
		expect(documentationOf(index, symbolKeyOf("a.ts", "local 0"))).toEqual([]);
	});

	test("hasDefinition/referenceCount are false/zero for an unknown key", async () => {
		const index = await decode(buildFixtureIndex());
		const unknownKey = symbolKeyOf(
			"a.ts",
			"scip-typescript npm nowhere 1.0.0 Nope#",
		);
		expect(hasDefinition(index, unknownKey)).toBe(false);
		expect(referenceCount(index, unknownKey)).toBe(0);
	});
});
