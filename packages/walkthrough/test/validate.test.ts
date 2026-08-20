import { describe, expect, test } from "bun:test";
import { serializeDocument } from "../src/document.ts";
import type { Walkthrough } from "../src/schema.ts";
import { decodeBuffer, evaluateWalkthrough } from "../src/validate.ts";

const patch = [
	"diff --git a/a.ts b/a.ts",
	"--- a/a.ts",
	"+++ b/a.ts",
	"@@ -1,2 +1,3 @@",
	" line1",
	"+line2",
	"+line3",
	" line4",
	"",
].join("\n");

const validDoc: Walkthrough = {
	version: 1,
	sections: [{ title: "Intro", body: "See [x](ref:r1)." }],
	references: [
		{
			id: "r1",
			label: "Foo",
			locations: [{ path: "a.ts", startLine: 2, endLine: 3 }],
		},
	],
};

const validDocument = serializeDocument(validDoc);

describe("decodeBuffer", () => {
	test("reports parse errors as feedback, not a thrown error", () => {
		const result = decodeBuffer("no fence, no heading, just prose");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("references fenced block");
	});

	// An agent that never called `write` used to be told the buffer "isn't
	// valid JSON: Unexpected EOF", which describes parsing nothing and names
	// no next step — so every retry repeated the same non-move.
	test("tells an agent that wrote nothing to call `write`, not that the document is malformed", () => {
		for (const empty of ["", "   \n\t "]) {
			const result = decodeBuffer(empty);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.message).toContain("`write`");
				expect(result.message).not.toContain("parse errors");
			}
		}
	});

	test("reports a malformed reference block as feedback", () => {
		// Drops the colon from "r1: Foo", so the line no longer matches the
		// block-header grammar at all.
		const broken = validDocument.replace("r1: Foo", "r1 Foo");
		const result = decodeBuffer(broken);
		expect(result.ok).toBe(false);
	});

	test("decodes a well-formed document", () => {
		const result = decodeBuffer(validDocument);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.walkthrough.version).toBe(1);
	});
});

describe("evaluateWalkthrough", () => {
	test("accepts a walkthrough that fully covers every changed file, reporting no gaps", () => {
		const evaluation = evaluateWalkthrough(validDocument, [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("valid");
		if (evaluation.status === "valid") {
			expect(evaluation.coverageGaps).toEqual([]);
		}
	});

	test("accepts a walkthrough with uncovered hunks as valid, reporting the gaps instead of rejecting it", () => {
		const doc: Walkthrough = {
			...validDoc,
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "a.ts", startLine: 2, endLine: 2 }],
				},
			],
		};
		const evaluation = evaluateWalkthrough(serializeDocument(doc), [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("valid");
		if (evaluation.status === "valid") {
			expect(evaluation.coverageGaps).toEqual([
				{ path: "a.ts", missingRanges: [{ startLine: 3, endLine: 3 }] },
			]);
		}
	});

	test("returns decode feedback before checking references or coverage", () => {
		const evaluation = evaluateWalkthrough(
			"not a walkthrough document at all",
			[{ path: "a.ts", patch, lineCount: 4 }],
		);
		expect(evaluation.status).toBe("invalid");
		if (evaluation.status === "invalid")
			expect(evaluation.feedback).toContain("references fenced block");
	});

	test("checks reference integrity before coverage — a hallucinated path is reported as a reference issue, not a coverage gap", () => {
		const doc: Walkthrough = {
			...validDoc,
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "ghost.ts", startLine: 1, endLine: 1 }],
				},
			],
		};
		const evaluation = evaluateWalkthrough(serializeDocument(doc), [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("invalid");
		if (evaluation.status === "invalid") {
			expect(evaluation.feedback).toContain("ghost.ts");
			expect(evaluation.feedback).not.toContain("Coverage is incomplete");
		}
	});
});
