import { describe, expect, test } from "bun:test";
import {
	formatDocumentErrors,
	parseDocument,
	serializeDocument,
} from "../src/document.ts";
import type { Walkthrough } from "../src/schema.ts";

const doc: Walkthrough = {
	version: 1,
	sections: [
		{
			title: "Why the guard changed",
			body: "Prose. May use `code`, **bold**, lists, and `###` sub-headings freely.\nLinks into the diff use [this form](ref:auth-guard).",
		},
		{
			title: "Second section",
			body: "More prose.",
		},
	],
	references: [
		{
			id: "auth-guard",
			label: "Guard short-circuits on expired sessions",
			locations: [
				{ path: "packages/auth/src/guard.ts", startLine: 12, endLine: 45 },
				{ path: "packages/auth/src/guard.ts", startLine: 80, endLine: 91 },
			],
		},
		{
			id: "session-ttl",
			label: "Session store gained a TTL",
			locations: [
				{ path: "packages/review/src/store.ts", startLine: 210, endLine: 230 },
			],
		},
	],
};

describe("round-trip", () => {
	test("parseDocument(serializeDocument(doc)) reproduces the original walkthrough", () => {
		const result = parseDocument(serializeDocument(doc));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.walkthrough).toEqual(doc);
	});

	test("a path containing a colon still round-trips — the location's path is parsed greedily from the left", () => {
		const withColonPath: Walkthrough = {
			version: 1,
			sections: [{ title: "Intro", body: "See [x](ref:r1)." }],
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "notes/draft:v2.md", startLine: 5, endLine: 10 }],
				},
			],
		};
		const result = parseDocument(serializeDocument(withColonPath));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.walkthrough).toEqual(withColonPath);
	});

	test("a single reference block with a single location round-trips", () => {
		const minimal: Walkthrough = {
			version: 1,
			sections: [{ title: "Only section", body: "" }],
			references: [
				{
					id: "r1",
					label: "Label",
					locations: [{ path: "a.ts", startLine: 1, endLine: 1 }],
				},
			],
		};
		const result = parseDocument(serializeDocument(minimal));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.walkthrough).toEqual(minimal);
	});

	test("zero reference blocks round-trip to an empty references array", () => {
		const noRefs: Walkthrough = {
			version: 1,
			sections: [{ title: "Only section", body: "No references needed." }],
			references: [],
		};
		const result = parseDocument(serializeDocument(noRefs));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.walkthrough).toEqual(noRefs);
	});
});

describe("parseDocument error cases", () => {
	test("zero ```references fences is an error", () => {
		const result = parseDocument("## Title\n\nBody, no fence anywhere.\n");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0]).toEqual({
				line: 1,
				message:
					"No ```references fenced block found — the document must contain exactly one.",
			});
		}
	});

	test("more than one ```references fence is an error, reported at the second fence's line", () => {
		const text = [
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"- x.ts:1-2",
			"```",
			"",
			"```references",
			"b: B",
			"- y.ts:1-2",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			const fenceCountError = result.errors.find((error) =>
				error.message.includes("Found 2"),
			);
			expect(fenceCountError).toEqual({
				line: 10,
				message:
					"Found 2 ```references fenced blocks — the document must contain exactly one.",
			});
		}
	});

	test("an unterminated ```references fence is an error at the opening line", () => {
		const text = [
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"- x.ts:1-2",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 5,
				message: "```references fence is never closed with ```.",
			});
		}
	});

	test("non-blank content before the first `## ` heading is an error at that line", () => {
		const text = [
			"Stray preamble text.",
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"- x.ts:1-2",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 1,
				message: "Content appears before the first section heading (`## `).",
			});
		}
	});

	test("a section heading with no title is an error at that line", () => {
		const text = [
			"## ",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"- x.ts:1-2",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 1,
				message: "Section heading has no title.",
			});
		}
	});

	test("a document with a fence but no `## ` heading anywhere is an error naming the missing section", () => {
		const text = ["```references", "a: A", "- x.ts:1-2", "```", ""].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 5,
				message:
					"The document has no sections — at least one `## ` heading is required.",
			});
		}
	});

	test("a location line before any reference block header is an error at that line", () => {
		const text = [
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"- x.ts:1-2",
			"a: A",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 6,
				message: "Location line appears before any reference block header.",
			});
		}
	});

	test("a reference block with no locations is an error at the block's header line", () => {
		const text = [
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"",
			"b: B",
			"- x.ts:1-2",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 6,
				message:
					'Reference block "a" has no locations — every block needs at least one.',
			});
		}
	});

	test("a location line whose start or end is less than 1 is an error at that line", () => {
		const text = [
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"- x.ts:0-2",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 7,
				message: "Location line numbers must be 1 or greater.",
			});
		}
	});

	test("any other non-blank fence line is an error at that line", () => {
		const text = [
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"a: A",
			"- x.ts:1-2",
			"just some stray text",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toContainEqual({
				line: 8,
				message: "Not a valid reference block header or location line.",
			});
		}
	});

	test("multiple errors across the document are all collected, sorted by line number", () => {
		const text = [
			"Stray preamble.",
			"## Title",
			"",
			"Body.",
			"",
			"```references",
			"- orphan.ts:1-2",
			"a: A",
			"- x.ts:1-2",
			"```",
			"",
		].join("\n");
		const result = parseDocument(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors.map((error) => error.line)).toEqual([1, 7]);
		}
	});
});

describe("formatDocumentErrors", () => {
	test("formats each error as a bulleted, line-numbered entry", () => {
		const text = formatDocumentErrors([
			{ line: 3, message: "Something is wrong." },
			{ line: 9, message: "Something else is wrong." },
		]);
		expect(text).toContain("- Line 3: Something is wrong.");
		expect(text).toContain("- Line 9: Something else is wrong.");
	});
});
