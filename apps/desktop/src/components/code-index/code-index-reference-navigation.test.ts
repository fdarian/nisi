import { describe, expect, test } from "bun:test";
import {
	flattenVisibleReferences,
	initialReferenceIndex,
	moveReferenceIndex,
	referenceNavigationGroup,
} from "#/components/code-index/code-index-reference-navigation";
import type { CodeIndexPeekTarget } from "#/components/code-index/use-code-index-interactions";

const firstReference = {
	line: 4,
	charStart: 2,
	charEnd: 13,
	lineText: "const first = value;",
};
const secondReference = {
	line: 9,
	charStart: 4,
	charEnd: 10,
	lineText: "return value;",
};
const thirdReference = {
	line: 2,
	charStart: 0,
	charEnd: 6,
	lineText: "value();",
};

const target = (
	path: string,
	line: number,
	charStart: number,
): CodeIndexPeekTarget => ({
	path,
	occurrence: {
		line,
		charStart,
		charEnd: charStart + 1,
		symbolKey: `${path}:${line}:${charStart}`,
	},
});

describe("reference navigation", () => {
	test("flattens open groups in file order and skips collapsed groups", () => {
		const visibleReferences = flattenVisibleReferences([
			referenceNavigationGroup(
				{ path: "a.ts", references: [firstReference, secondReference] },
				true,
			),
			referenceNavigationGroup(
				{ path: "b.ts", references: [thirdReference] },
				false,
			),
		]);

		expect(
			visibleReferences.map((item) => `${item.path}:${item.reference.line}`),
		).toEqual(["a.ts:4", "a.ts:9"]);
	});

	test("moves across groups and clamps at both ends", () => {
		expect(moveReferenceIndex(undefined, 1, 3)).toBe(0);
		expect(moveReferenceIndex(0, -1, 3)).toBe(0);
		expect(moveReferenceIndex(1, 1, 3)).toBe(2);
		expect(moveReferenceIndex(2, 1, 3)).toBe(2);
		expect(moveReferenceIndex(undefined, -1, 3)).toBe(2);
		expect(moveReferenceIndex(0, 1, 0)).toBeUndefined();
	});

	test("selects the clicked reference, falling back to the first row", () => {
		const visibleReferences = flattenVisibleReferences([
			referenceNavigationGroup(
				{ path: "a.ts", references: [firstReference, secondReference] },
				true,
			),
			referenceNavigationGroup(
				{ path: "b.ts", references: [thirdReference] },
				true,
			),
		]);

		expect(initialReferenceIndex(visibleReferences, target("a.ts", 9, 4))).toBe(
			1,
		);
		expect(
			initialReferenceIndex(visibleReferences, target("missing.ts", 1, 0)),
		).toBe(0);
	});
});
