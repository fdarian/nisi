import { describe, expect, test } from "bun:test";
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

const validDoc = {
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

describe("decodeBuffer", () => {
	test("reports invalid JSON as feedback, not a thrown error", () => {
		const result = decodeBuffer("{not json");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.message).toContain("isn't valid JSON");
	});

	test("reports a schema mismatch as feedback", () => {
		const result = decodeBuffer(JSON.stringify({ version: 2 }));
		expect(result.ok).toBe(false);
	});

	test("decodes a well-formed buffer", () => {
		const result = decodeBuffer(JSON.stringify(validDoc));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.walkthrough.version).toBe(1);
	});
});

describe("evaluateWalkthrough", () => {
	test("accepts a walkthrough that fully covers every changed file", () => {
		const evaluation = evaluateWalkthrough(JSON.stringify(validDoc), [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("valid");
	});

	test("returns decode feedback before checking references or coverage", () => {
		const evaluation = evaluateWalkthrough("not json at all", [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("invalid");
		if (evaluation.status === "invalid")
			expect(evaluation.feedback).toContain("JSON");
	});

	test("checks reference integrity before coverage — a hallucinated path is reported as a reference issue, not a coverage gap", () => {
		const doc = {
			...validDoc,
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "ghost.ts", startLine: 1, endLine: 1 }],
				},
			],
		};
		const evaluation = evaluateWalkthrough(JSON.stringify(doc), [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("invalid");
		if (evaluation.status === "invalid") {
			expect(evaluation.feedback).toContain("ghost.ts");
			expect(evaluation.feedback).not.toContain("Coverage is incomplete");
		}
	});

	test("reports a coverage gap once references are otherwise valid", () => {
		const doc = {
			...validDoc,
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "a.ts", startLine: 2, endLine: 2 }],
				},
			],
		};
		const evaluation = evaluateWalkthrough(JSON.stringify(doc), [
			{ path: "a.ts", patch, lineCount: 4 },
		]);
		expect(evaluation.status).toBe("invalid");
		if (evaluation.status === "invalid") {
			expect(evaluation.feedback).toContain("Coverage is incomplete");
			expect(evaluation.feedback).toContain("line 3");
		}
	});
});
