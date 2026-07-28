import { describe, expect, test } from "bun:test";
import {
	extractReferenceLinks,
	formatReferenceFeedback,
	validateReferences,
} from "../src/references.ts";
import type { Walkthrough } from "../src/schema.ts";

describe("extractReferenceLinks", () => {
	test("extracts every ref: link in order, ignoring ordinary markdown links", () => {
		const body =
			"See [first](ref:r1) and also [second](ref:r2), but not [external](https://x).";
		expect(extractReferenceLinks(body)).toEqual(["r1", "r2"]);
	});

	test("returns an empty array when there are no links", () => {
		expect(extractReferenceLinks("plain prose, no links")).toEqual([]);
	});
});

const walkthrough = (overrides: Partial<Walkthrough>): Walkthrough => ({
	version: 1,
	sections: [{ title: "Intro", body: "See [x](ref:r1)." }],
	references: [
		{
			id: "r1",
			label: "Foo",
			locations: [{ path: "a.ts", startLine: 1, endLine: 2 }],
		},
	],
	...overrides,
});

describe("validateReferences", () => {
	test("passes a fully consistent walkthrough", () => {
		const lineCounts = new Map([["a.ts", 10]]);
		expect(validateReferences(walkthrough({}), lineCounts)).toEqual([]);
	});

	test("flags a duplicate reference id", () => {
		const doc = walkthrough({
			references: [
				{
					id: "r1",
					label: "A",
					locations: [{ path: "a.ts", startLine: 1, endLine: 1 }],
				},
				{
					id: "r1",
					label: "B",
					locations: [{ path: "a.ts", startLine: 2, endLine: 2 }],
				},
			],
		});
		const issues = validateReferences(doc, new Map([["a.ts", 10]]));
		expect(issues).toContainEqual({ type: "duplicate-id", id: "r1" });
	});

	test("flags a section link that doesn't resolve to a real block", () => {
		const doc = walkthrough({
			sections: [{ title: "Intro", body: "[x](ref:missing)" }],
		});
		const issues = validateReferences(doc, new Map([["a.ts", 10]]));
		expect(issues).toContainEqual({
			type: "dangling-link",
			sectionTitle: "Intro",
			id: "missing",
		});
	});

	test("flags a location pointing at a file that isn't in the changed-file set", () => {
		const issues = validateReferences(walkthrough({}), new Map());
		expect(issues).toContainEqual({
			type: "unknown-file",
			refId: "r1",
			path: "a.ts",
		});
	});

	test("flags startLine after endLine", () => {
		const doc = walkthrough({
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "a.ts", startLine: 5, endLine: 2 }],
				},
			],
		});
		const issues = validateReferences(doc, new Map([["a.ts", 10]]));
		expect(issues).toContainEqual({
			type: "invalid-range",
			refId: "r1",
			path: "a.ts",
			startLine: 5,
			endLine: 2,
		});
	});

	test("flags a location past the file's actual line count", () => {
		const doc = walkthrough({
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "a.ts", startLine: 1, endLine: 50 }],
				},
			],
		});
		const issues = validateReferences(doc, new Map([["a.ts", 10]]));
		expect(issues).toContainEqual({
			type: "out-of-range",
			refId: "r1",
			path: "a.ts",
			startLine: 1,
			endLine: 50,
			lineCount: 10,
		});
	});
});

describe("formatReferenceFeedback", () => {
	test("describes each issue in a readable, agent-actionable way", () => {
		const text = formatReferenceFeedback([
			{ type: "duplicate-id", id: "r1" },
			{ type: "unknown-file", refId: "r2", path: "ghost.ts" },
		]);
		expect(text).toContain('"r1"');
		expect(text).toContain("ghost.ts");
	});
});
