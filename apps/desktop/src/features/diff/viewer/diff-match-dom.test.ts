import { afterAll, describe, expect, test } from "bun:test";
import { paintedSelectionMatchesRange } from "./diff-match-dom";

const originalHTMLElement = globalThis.HTMLElement;

class Row {
	constructor(
		readonly line: number,
		readonly marker: string | null,
		readonly side: "deletions" | "additions" | "unified",
		readonly deletion = false,
	) {}

	getAttribute(name: string): string | null {
		if (name === "data-selected-line") return this.marker;
		if (name === "data-line-type") {
			return this.deletion ? "change-deletion" : "context";
		}
		return null;
	}

	hasAttribute(name: string): boolean {
		return name === "data-selected-line" && this.marker !== null;
	}

	closest(): { hasAttribute: (name: string) => boolean } | null {
		if (this.side === "unified") return null;
		return { hasAttribute: (name) => name === `data-${this.side}` };
	}
}

Object.defineProperty(globalThis, "HTMLElement", {
	value: Row,
	configurable: true,
});
afterAll(() => {
	Object.defineProperty(globalThis, "HTMLElement", {
		value: originalHTMLElement,
		configurable: true,
	});
});

function root(rows: Row[]): ParentNode {
	return {
		querySelectorAll: (selector: string) => {
			const line = Number(selector.match(/\d+/)?.[0]);
			return rows.filter((row) => row.line === line);
		},
	} as unknown as ParentNode;
}

describe("painted gutter selection", () => {
	test("waits for the callback's endpoints instead of accepting the previous range", () => {
		const oldRows = root([
			new Row(10, "first", "unified"),
			new Row(11, "", "unified"),
			new Row(12, "last", "unified"),
		]);
		expect(paintedSelectionMatchesRange(oldRows, { start: 10, end: 12 })).toBe(
			true,
		);
		expect(paintedSelectionMatchesRange(oldRows, { start: 10, end: 11 })).toBe(
			false,
		);
		expect(paintedSelectionMatchesRange(oldRows, { start: 12, end: 10 })).toBe(
			true,
		);
		expect(paintedSelectionMatchesRange(root([]), { start: 10, end: 12 })).toBe(
			false,
		);
	});

	test("distinguishes unified deletion rows from additions with the same number", () => {
		const rows = root([
			new Row(7, "single", "unified", true),
			new Row(7, null, "unified"),
		]);
		expect(
			paintedSelectionMatchesRange(rows, {
				start: 7,
				end: 7,
				side: "deletions",
			}),
		).toBe(true);
		expect(
			paintedSelectionMatchesRange(rows, {
				start: 7,
				end: 7,
				side: "additions",
			}),
		).toBe(false);
	});

	test("checks split context lines by column, including a cross-side range", () => {
		const rows = root([
			new Row(7, "first", "deletions"),
			new Row(7, "first", "additions"),
			new Row(8, "last", "additions"),
		]);
		expect(
			paintedSelectionMatchesRange(rows, {
				start: 7,
				end: 8,
				side: "deletions",
				endSide: "additions",
			}),
		).toBe(true);
		expect(
			paintedSelectionMatchesRange(rows, {
				start: 7,
				end: 8,
				side: "additions",
				endSide: "deletions",
			}),
		).toBe(false);
	});
});
