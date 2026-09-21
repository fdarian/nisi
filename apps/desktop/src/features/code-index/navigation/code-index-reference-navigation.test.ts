import { describe, expect, test } from "bun:test";
import {
	flattenVisibleReferences,
	initialReferenceIndex,
	moveReferenceIndex,
	REFERENCE_CONTEXT_PREFETCH_RADIUS,
	referenceContextWindow,
	referenceNavigationGroup,
} from "./code-index-reference-navigation";
import type { CodeIndexPeekTarget } from "#/features/code-index/use-code-index-interactions";

const firstReference = {
	line: 4,
	charStart: 2,
	charEnd: 13,
	lineText: "const first = value;",
	isDefinition: false,
};
const secondReference = {
	line: 9,
	charStart: 4,
	charEnd: 10,
	lineText: "return value;",
	isDefinition: false,
};
const thirdReference = {
	line: 2,
	charStart: 0,
	charEnd: 6,
	lineText: "value();",
	isDefinition: false,
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

	test("keeps the selected row and a bounded visible-row prefetch window", () => {
		const visibleReferences = flattenVisibleReferences([
			referenceNavigationGroup(
				{
					path: "a.ts",
					references: [
						firstReference,
						secondReference,
						thirdReference,
						firstReference,
						secondReference,
						thirdReference,
					],
				},
				true,
			),
		]);

		expect(
			referenceContextWindow(visibleReferences, 3).map((item) => item.index),
		).toEqual(
			[0, 1, 2, 3, 4, 5].slice(
				Math.max(0, 3 - REFERENCE_CONTEXT_PREFETCH_RADIUS),
				Math.min(6, 3 + REFERENCE_CONTEXT_PREFETCH_RADIUS + 1),
			),
		);
		expect(
			referenceContextWindow(visibleReferences, 0).map((item) => item.index),
		).toEqual([0, 1, 2, 3]);
		expect(referenceContextWindow(visibleReferences, undefined)).toEqual([]);
	});
});
