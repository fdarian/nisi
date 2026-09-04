import { describe, expect, test } from "bun:test";
import {
	buildReferencesResponse,
	groupReferencesByFile,
} from "../state.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Regression test for the bug found via live testing: scip-typescript
 * indexes the working tree at build time, and the on-disk cache's
 * staleness check only tracks *committed* head-sha movement
 * (`resolveCodeIndexStatus`). An edit to a file after the index was built —
 * committed or not — can shift every later line without ever moving
 * `headSha`, so a location's recorded `line`/`charStart`/`charEnd` can point
 * at the wrong text in the *current* file even while `status` still reports
 * `"ready"`. Confirmed live: an index recorded a `CodeIndexReference`
 * occurrence at line 382 of `code-index-peek-panel.tsx`; by the time
 * `references` read "current" content, ~20 lines had been inserted above
 * it, so current line 382 was a `</CollapsibleTrigger>` JSX close tag
 * instead — a different, unrelated line, not an off-by-one.
 */
describe("groupReferencesByFile — drift detection", () => {
	test("a global symbol's slice matching displayName is trusted as-is", () => {
		const fileContents = new Map([
			["a.ts", encode("const CodeIndexReference = 1;\n")],
		]);
		const result = groupReferencesByFile(
			[{ path: "a.ts", line: 0, charStart: 6, charEnd: 24 }],
			fileContents,
			"CodeIndexReference",
			false,
		);
		expect(result).toEqual([
			{
				path: "a.ts",
				references: [
					{
						line: 0,
						charStart: 6,
						charEnd: 24,
						lineText: "const CodeIndexReference = 1;",
					},
				],
			},
		]);
	});

	test("live-verified repro: a drifted global-symbol location reports lineText: null instead of the wrong line's text", () => {
		// The index recorded this occurrence at line 1 ("group: {...}" in the
		// indexed snapshot). Since then, the file gained a line above it, so
		// "current" line 1 is now something else entirely — exactly the
		// </CollapsibleTrigger> mismatch seen live.
		const fileContents = new Map([
			[
				"code-index-peek-panel.tsx",
				encode("function FileReferenceGroup() {\n\t\t\t</CollapsibleTrigger>\n"),
			],
		]);
		const result = groupReferencesByFile(
			[
				{
					path: "code-index-peek-panel.tsx",
					line: 1,
					charStart: 4,
					charEnd: 34,
				},
			],
			fileContents,
			"CodeIndexReference",
			false,
		);
		expect(result).toEqual([
			{
				path: "code-index-peek-panel.tsx",
				references: [{ line: 1, charStart: 4, charEnd: 34, lineText: null }],
			},
		]);
	});

	test("a missing file (path absent from fileContents) reports lineText: null", () => {
		const result = groupReferencesByFile(
			[{ path: "gone.ts", line: 0, charStart: 0, charEnd: 3 }],
			new Map(),
			"foo",
			false,
		);
		expect(result[0]?.references[0]?.lineText).toBeNull();
	});

	test("a line past the end of the (now-shorter) file reports lineText: null", () => {
		const fileContents = new Map([["a.ts", encode("only one line\n")]]);
		const result = groupReferencesByFile(
			[{ path: "a.ts", line: 5, charStart: 0, charEnd: 3 }],
			fileContents,
			"foo",
			false,
		);
		expect(result[0]?.references[0]?.lineText).toBeNull();
	});

	test("a local symbol's slice that looks like a real identifier is trusted, even though its displayName is just scip-typescript's numeric counter", () => {
		const fileContents = new Map([["a.ts", encode("const total = 1;\n")]]);
		const result = groupReferencesByFile(
			[{ path: "a.ts", line: 0, charStart: 6, charEnd: 11 }],
			fileContents,
			"3", // local symbols' displayName is a per-document counter, not "total"
			true,
		);
		expect(result[0]?.references[0]?.lineText).toBe("const total = 1;");
	});

	test("a local symbol's slice that doesn't look like an identifier at all is still flagged stale", () => {
		const fileContents = new Map([["a.ts", encode("</CollapsibleTrigger>\n")]]);
		const result = groupReferencesByFile(
			[{ path: "a.ts", line: 0, charStart: 0, charEnd: 21 }],
			fileContents,
			"3",
			true,
		);
		expect(result[0]?.references[0]?.lineText).toBeNull();
	});

	test("groups multiple locations by path", () => {
		const fileContents = new Map([
			["a.ts", encode("const foo = 1;\nconst foo2 = foo;\n")],
		]);
		const result = groupReferencesByFile(
			[
				{ path: "a.ts", line: 0, charStart: 6, charEnd: 9 },
				{ path: "a.ts", line: 1, charStart: 29, charEnd: 32 },
			],
			fileContents,
			"foo",
			false,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.references).toHaveLength(2);
	});
});

describe("buildReferencesResponse", () => {
	test("threads displayName/isLocal from the plan into the drift check", () => {
		const fileContents = new Map([["a.ts", encode("const drifted = 1;\n")]]);
		const plan = {
			displayName: "foo",
			isLocal: false,
			documentation: [],
			definition: null,
			totalReferenceCount: 1,
			returnedLocations: [
				{ path: "a.ts", line: 0, charStart: 6, charEnd: 13 },
			],
		};
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.files).toEqual([
			{
				path: "a.ts",
				references: [{ line: 0, charStart: 6, charEnd: 13, lineText: null }],
			},
		]);
		expect(response.returnedReferenceCount).toBe(1);
		expect(response.totalReferenceCount).toBe(1);
	});
});
