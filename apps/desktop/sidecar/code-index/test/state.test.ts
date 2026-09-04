import { describe, expect, test } from "bun:test";
import { LspProcessError, TsLspBinaryResolutionError } from "@repo/code-lsp";
import {
	buildReferencesResponse,
	describeBuildFailure,
	groupReferencesByFile,
} from "../state.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * Unlike the SCIP-backed version this replaces, `groupReferencesByFile` no
 * longer verifies anything against a symbol's expected display name — the
 * LSP server that resolved each location and the worktree read that backs
 * `fileContents` both describe the same live file at query time, so there's
 * no drift for it to guard against (see `packages/sidecar-api/src/code-index.ts`'s
 * updated doc comment on `CodeIndexReference.lineText`). These tests only
 * cover the two genuine "can't back this" cases: a path that was never
 * fetched, and a recorded line past a file's current length.
 */
describe("groupReferencesByFile", () => {
	test("attaches each location's own line text", () => {
		const fileContents = new Map([
			["a.ts", encode("const foo = 1;\nconst foo2 = foo;\n")],
		]);
		const result = groupReferencesByFile(
			[
				{ path: "a.ts", line: 0, charStart: 6, charEnd: 9 },
				{ path: "a.ts", line: 1, charStart: 29, charEnd: 32 },
			],
			fileContents,
		);
		expect(result).toEqual([
			{
				path: "a.ts",
				references: [
					{ line: 0, charStart: 6, charEnd: 9, lineText: "const foo = 1;" },
					{
						line: 1,
						charStart: 29,
						charEnd: 32,
						lineText: "const foo2 = foo;",
					},
				],
			},
		]);
	});

	test("a missing file (path absent from fileContents) reports lineText: null", () => {
		const result = groupReferencesByFile(
			[{ path: "gone.ts", line: 0, charStart: 0, charEnd: 3 }],
			new Map(),
		);
		expect(result[0]?.references[0]?.lineText).toBeNull();
	});

	test("a line past the end of the (now-shorter) file reports lineText: null", () => {
		const fileContents = new Map([["a.ts", encode("only one line\n")]]);
		const result = groupReferencesByFile(
			[{ path: "a.ts", line: 5, charStart: 0, charEnd: 3 }],
			fileContents,
		);
		expect(result[0]?.references[0]?.lineText).toBeNull();
	});

	test("groups multiple locations across different paths separately", () => {
		const fileContents = new Map([
			["a.ts", encode("const foo = 1;\n")],
			["b.ts", encode("import { foo } from './a';\n")],
		]);
		const result = groupReferencesByFile(
			[
				{ path: "a.ts", line: 0, charStart: 6, charEnd: 9 },
				{ path: "b.ts", line: 0, charStart: 9, charEnd: 12 },
			],
			fileContents,
		);
		expect(result).toHaveLength(2);
	});
});

describe("buildReferencesResponse", () => {
	const basePlan = (
		overrides: Partial<Parameters<typeof buildReferencesResponse>[0]> = {},
	) => ({
		symbolPath: "a.ts",
		symbolLine: 0,
		symbolChar: 6,
		documentation: [],
		definition: null,
		totalReferenceCount: 0,
		returnedLocations: [],
		...overrides,
	});

	test("derives displayName from the live source text at the symbol's own position", () => {
		const fileContents = new Map([["a.ts", encode("const total = 1;\n")]]);
		const response = buildReferencesResponse(basePlan(), fileContents);
		expect(response.displayName).toBe("total");
	});

	test("displayName is empty when the symbol's own file wasn't fetched", () => {
		const response = buildReferencesResponse(basePlan(), new Map());
		expect(response.displayName).toBe("");
	});

	test("threads returnedLocations into files, with each one's line text", () => {
		const fileContents = new Map([["a.ts", encode("const drifted = 1;\n")]]);
		const plan = basePlan({
			symbolPath: "a.ts",
			symbolChar: 6,
			totalReferenceCount: 1,
			returnedLocations: [{ path: "a.ts", line: 0, charStart: 6, charEnd: 13 }],
		});
		const response = buildReferencesResponse(plan, fileContents);
		expect(response.files).toEqual([
			{
				path: "a.ts",
				references: [
					{
						line: 0,
						charStart: 6,
						charEnd: 13,
						lineText: "const drifted = 1;",
					},
				],
			},
		]);
		expect(response.returnedReferenceCount).toBe(1);
		expect(response.totalReferenceCount).toBe(1);
	});

	describe("definitionContext", () => {
		test("a definition gets a padded context window (3 lines before, 4 after)", () => {
			const fileContents = new Map([
				[
					"a.ts",
					encode(
						"line0\nline1\nline2\nfunction myFunction() {}\nline4\nline5\nline6\nline7\nline8\n",
					),
				],
			]);
			const plan = basePlan({
				definition: { path: "a.ts", line: 3, charStart: 9, charEnd: 19 },
			});
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

		test("no definition means no context, not an error", () => {
			const response = buildReferencesResponse(basePlan(), new Map());
			expect(response.definitionContext).toBeNull();
			expect(response.definition).toBeNull();
		});

		test("a definition's file missing from fileContents reports definitionContext: null", () => {
			const plan = basePlan({
				definition: { path: "gone.ts", line: 0, charStart: 0, charEnd: 3 },
			});
			const response = buildReferencesResponse(plan, new Map());
			expect(response.definitionContext).toBeNull();
			// The location itself is still reported — only the text preview is
			// withheld, so the frontend can still say *where* it is.
			expect(response.definition).toEqual({
				path: "gone.ts",
				line: 0,
				charStart: 0,
				charEnd: 3,
			});
		});

		test("clamps the context window at the start of the file", () => {
			const fileContents = new Map([
				[
					"a.ts",
					encode("function myFunction() {}\nline1\nline2\nline3\nline4\n"),
				],
			]);
			const plan = basePlan({
				definition: { path: "a.ts", line: 0, charStart: 9, charEnd: 19 },
			});
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
			const plan = basePlan({
				definition: { path: "a.ts", line: 2, charStart: 9, charEnd: 19 },
			});
			const response = buildReferencesResponse(plan, fileContents);
			expect(response.definitionContext?.lines.at(-1)).toBe(
				"function myFunction() {}",
			);
		});
	});
});

describe("describeBuildFailure", () => {
	test("formats a binary resolution failure with its own strategy", () => {
		const failure = new TsLspBinaryResolutionError({
			strategy: "dev-get-exe-path",
			cause: new Error("boom"),
		});
		expect(describeBuildFailure(failure)).toContain("dev-get-exe-path");
		expect(describeBuildFailure(failure)).toContain("resolve");
	});

	test("formats a spawn failure distinctly from an initialize failure", () => {
		const spawnFailure = new LspProcessError({
			step: "spawn",
			cause: new Error("ENOENT"),
		});
		const initializeFailure = new LspProcessError({
			step: "initialize",
			cause: new Error("timeout"),
		});
		expect(describeBuildFailure(spawnFailure)).toContain("start");
		expect(describeBuildFailure(initializeFailure)).toContain("initialize");
	});
});
