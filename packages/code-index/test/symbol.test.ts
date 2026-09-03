import { describe, expect, test } from "bun:test";
import {
	deriveDisplayName,
	isLocalSymbol,
	parseSymbol,
	symbolKeyOf,
} from "../src/symbol.ts";

const METHOD_SYMBOL = "scip-typescript npm mypackage 1.0.0 MyClass#myMethod().";
const OVERLOAD_SYMBOL =
	"scip-typescript npm mypackage 1.0.0 MyClass#myMethod(+1).";
const NAMESPACE_SYMBOL = "scip-typescript npm mypackage 1.0.0 outer/inner#";

describe("isLocalSymbol", () => {
	test("recognizes the 'local ' prefix", () => {
		expect(isLocalSymbol("local 5")).toBe(true);
	});

	test("rejects a global symbol", () => {
		expect(isLocalSymbol(METHOD_SYMBOL)).toBe(false);
	});
});

describe("parseSymbol", () => {
	test("parses a local symbol's id", () => {
		const parsed = parseSymbol("local 5");
		expect(parsed).toEqual({ kind: "local", localId: "5" });
	});

	test("parses scheme/package/version and a method descriptor", () => {
		const parsed = parseSymbol(METHOD_SYMBOL);
		expect(parsed.kind).toBe("global");
		if (parsed.kind !== "global") throw new Error("unreachable");
		expect(parsed.scheme).toBe("scip-typescript");
		expect(parsed.packageManager).toBe("npm");
		expect(parsed.packageName).toBe("mypackage");
		expect(parsed.packageVersion).toBe("1.0.0");
		expect(parsed.descriptors).toEqual([
			{ name: "MyClass", suffix: "type", disambiguator: "" },
			{ name: "myMethod", suffix: "method", disambiguator: "" },
		]);
	});

	test("parses a method disambiguator (overload marker)", () => {
		const parsed = parseSymbol(OVERLOAD_SYMBOL);
		if (parsed.kind !== "global") throw new Error("unreachable");
		expect(parsed.descriptors.at(-1)).toEqual({
			name: "myMethod",
			suffix: "method",
			disambiguator: "+1",
		});
	});

	test("parses a namespace descriptor chain", () => {
		const parsed = parseSymbol(NAMESPACE_SYMBOL);
		if (parsed.kind !== "global") throw new Error("unreachable");
		expect(parsed.descriptors).toEqual([
			{ name: "outer", suffix: "namespace", disambiguator: "" },
			{ name: "inner", suffix: "type", disambiguator: "" },
		]);
	});

	test("normalizes the '.' package-field placeholder to an empty string", () => {
		const parsed = parseSymbol("scip-typescript . . . term.");
		if (parsed.kind !== "global") throw new Error("unreachable");
		expect(parsed.packageManager).toBe("");
		expect(parsed.packageName).toBe("");
		expect(parsed.packageVersion).toBe("");
	});

	test("unescapes a doubled space inside a space-terminated field", () => {
		const parsed = parseSymbol("scheme mgr na  me version term.");
		if (parsed.kind !== "global") throw new Error("unreachable");
		expect(parsed.packageName).toBe("na me");
	});

	test("reads a backtick-escaped descriptor name, unescaping doubled backticks", () => {
		const parsed = parseSymbol(
			"scip-typescript npm mypackage 1.0.0 `weird``name`.",
		);
		if (parsed.kind !== "global") throw new Error("unreachable");
		expect(parsed.descriptors).toEqual([
			{ name: "weird`name", suffix: "term", disambiguator: "" },
		]);
	});

	test("throws on a global symbol with no descriptors", () => {
		expect(() => parseSymbol("scip-typescript npm mypackage 1.0.0 ")).toThrow();
	});
});

describe("deriveDisplayName", () => {
	test("uses the last descriptor's name for a global symbol", () => {
		expect(deriveDisplayName(parseSymbol(METHOD_SYMBOL))).toBe("myMethod");
	});

	test("uses the raw local id for a local symbol", () => {
		expect(deriveDisplayName(parseSymbol("local 5"))).toBe("5");
	});
});

describe("symbolKeyOf", () => {
	test("keys a global symbol by the symbol string alone, ignoring documentPath", () => {
		expect(symbolKeyOf("a.ts", METHOD_SYMBOL)).toBe(
			symbolKeyOf("b.ts", METHOD_SYMBOL),
		);
	});

	test("keys a local symbol by (documentPath, symbol) — two 'local 5's in different documents don't collide", () => {
		const keyInA = symbolKeyOf("a.ts", "local 5");
		const keyInB = symbolKeyOf("b.ts", "local 5");
		expect(keyInA).not.toBe(keyInB);
	});

	test("the same local symbol in the same document produces the same key", () => {
		expect(symbolKeyOf("a.ts", "local 5")).toBe(symbolKeyOf("a.ts", "local 5"));
	});

	test("a local key and a global key never collide", () => {
		const localKey = symbolKeyOf("a.ts", "local 5");
		const globalKey = symbolKeyOf("a.ts", METHOD_SYMBOL);
		expect(localKey).not.toBe(globalKey);
	});
});
