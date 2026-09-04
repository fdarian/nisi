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

/**
 * Regression tests for the follow-up bug: `Store.readCurrentContent` gates
 * worktree reads on the `includeUncommitted` setting, so with it off and a
 * dirty worktree at build time, `references`' old file-reading path served
 * last-committed content while the index (which scip-typescript always
 * builds from the working tree) described the dirty tree - two different
 * revisions of the same file compared against each other, which the drift
 * check correctly reports as a mismatch, but which no rebuild could ever
 * clear (rebuilding re-indexes the same dirty tree; the preview kept
 * reading the last commit regardless). The fix is `readWorktreeFileContents`
 * reading unconditionally - these tests exercise `buildDefinitionContext`
 * (via `buildReferencesResponse`) with `fileContents` standing in for
 * "whatever `readWorktreeFileContents` returned," proving the response
 * shape is correct once source and index agree, and null (not silently
 * wrong text) when they don't.
 */
describe("buildReferencesResponse - definitionContext", () => {
	const basePlan = (
		definition: {
			path: string;
			line: number;
			charStart: number;
			charEnd: number;
		} | null,
		isLocal = false,
	) => ({
		displayName: "myFunction",
		isLocal,
		documentation: [],
		definition,
		totalReferenceCount: 0,
		returnedLocations: [],
	});

	test("a definition whose slice matches displayName gets a verified context window", () => {
		const fileContents = new Map([
			[
				"a.ts",
				encode(
					"line0\nline1\nline2\nfunction myFunction() {}\nline4\nline5\nline6\nline7\nline8\n",
				),
			],
		]);
		const plan = basePlan({ path: "a.ts", line: 3, charStart: 9, charEnd: 19 });
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.definitionContext).toEqual({
			startLine: 0,
			lines: [
				"line0",
				"line1",
				"line2",
				"function myFunction() {}",
				"line4",
				"line5",
				"line6",
				"line7",
			],
		});
	});

	test("regression: content read from a different revision than the one the index described reports definitionContext: null, never the wrong window", () => {
		// The index recorded this definition at line 3 against the working
		// tree. `fileContents` here stands in for the bug: content from a
		// *different* revision (e.g. the last commit, via the old
		// includeUncommitted-gated read) where line 3 holds something else.
		const fileContents = new Map([
			["a.ts", encode("line0\nline1\nline2\nunrelated text here\nline4\n")],
		]);
		const plan = basePlan({ path: "a.ts", line: 3, charStart: 9, charEnd: 19 });
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.definitionContext).toBeNull();
		// The location itself is still reported - only the text preview is
		// withheld, so the frontend can still say *where* it is.
		expect(response.definition).toEqual({
			path: "a.ts",
			line: 3,
			charStart: 9,
			charEnd: 19,
		});
	});

	test("no definition means no context, not an error", () => {
		const response = buildReferencesResponse(basePlan(null), new Map());
		expect(response.definitionContext).toBeNull();
	});

	test("a definition's file missing from fileContents reports definitionContext: null", () => {
		const plan = basePlan({
			path: "gone.ts",
			line: 0,
			charStart: 0,
			charEnd: 3,
		});
		const response = buildReferencesResponse(plan, new Map());
		expect(response.definitionContext).toBeNull();
	});

	test("clamps the context window at the start of the file", () => {
		const fileContents = new Map([
			[
				"a.ts",
				encode("function myFunction() {}\nline1\nline2\nline3\nline4\n"),
			],
		]);
		const plan = basePlan({ path: "a.ts", line: 0, charStart: 9, charEnd: 19 });
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.definitionContext?.startLine).toBe(0);
		expect(response.definitionContext?.lines[0]).toBe(
			"function myFunction() {}",
		);
	});

	test("clamps the context window at the end of the file", () => {
		// No trailing newline, unlike the other fixtures — deliberately, so
		// the last array element from `.split("\n")` is the real last line
		// rather than the usual trailing empty string a real file's final
		// newline produces, keeping this assertion about clamping alone.
		const fileContents = new Map([
			["a.ts", encode("line0\nline1\nfunction myFunction() {}")],
		]);
		const plan = basePlan({ path: "a.ts", line: 2, charStart: 9, charEnd: 19 });
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.definitionContext?.lines.at(-1)).toBe(
			"function myFunction() {}",
		);
	});

	test("a local symbol's definition is checked with the weaker identifier-shape fallback, not exact-match against its numeric displayName", () => {
		const fileContents = new Map([
			["a.ts", encode("function outer() {\n  const total = 1;\n}\n")],
		]);
		const plan = basePlan(
			{ path: "a.ts", line: 1, charStart: 8, charEnd: 13 },
			true,
		);
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.definitionContext).not.toBeNull();
	});
});
