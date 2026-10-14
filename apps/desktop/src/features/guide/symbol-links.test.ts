import { expect, test } from "bun:test";
import { symbolFromCode, symbolMap } from "./symbol-links";

const symbols = symbolMap([
	{ name: "useThing", path: "src/use-thing.ts", line: 4 },
	{ name: "Store", path: "src/store.ts", line: 10 },
]);

test("a declared identifier, with or without call parentheses", () => {
	expect(symbolFromCode("useThing", symbols)?.line).toBe(4);
	expect(symbolFromCode("useThing()", symbols)?.line).toBe(4);
});

test("Foo.bar links to Foo when Foo is declared", () => {
	expect(symbolFromCode("Store.get", symbols)?.path).toBe("src/store.ts");
	expect(symbolFromCode("Other.get", symbols)).toBeNull();
});

test("anything that is not just a name stays plain", () => {
	expect(symbolFromCode("useThing(a)", symbols)).toBeNull();
	expect(symbolFromCode("useThing + 1", symbols)).toBeNull();
	expect(symbolFromCode("Store.", symbols)).toBeNull();
	expect(symbolFromCode("unknown", symbols)).toBeNull();
});

test("a filename stays plain even when its stem is a declared name", () => {
	const declared = symbolMap([{ name: "cli", path: "src/cli.ts", line: 2 }]);
	expect(symbolFromCode("cli.ts", declared)).toBeNull();
	expect(symbolFromCode("cli.test.ts", declared)).toBeNull();
	expect(symbolFromCode("cli.json", declared)).toBeNull();
	expect(symbolFromCode("src/cli.ts", declared)).toBeNull();
	expect(symbolFromCode("cli.run", declared)?.line).toBe(2);
	expect(symbolFromCode("cli.json()", declared)?.line).toBe(2);
});
