import { expect, test } from "bun:test";
import { comparePaths } from "./tree-paths";

test("frontend path ordering puts directories first at every level", () => {
	expect(
		["a.ts", "z/file.ts", "z/a/file.ts", "z/b.ts", "b.ts"].sort(comparePaths),
	).toEqual(["z/a/file.ts", "z/b.ts", "z/file.ts", "a.ts", "b.ts"]);
	expect(comparePaths("same", "same")).toBe(0);
});
