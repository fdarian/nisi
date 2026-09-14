import { describe, expect, test } from "bun:test";
import type { LspServer } from "@repo/code-lsp";
import {
	LspProcessError,
	LspRequestError,
	TsLspBinaryResolutionError,
} from "@repo/code-lsp";
import { Effect, RcMap, Semaphore } from "effect";
import {
	buildReferencesResponse,
	buildSourceContext,
	type CodeLspPoolValue,
	describeCodeIndexFailure,
	findImportIdentifierSpans,
	groupReferencesByFile,
	withCodeLspServer,
} from "../state.ts";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

test("same-root LSP leases allow operations to overlap", async () => {
	const fakeServer: LspServer = {
		rootPath: "root",
		openDocument: () => Effect.void,
		semanticTokensFull: () => Effect.succeed([]),
		references: () => Effect.succeed([]),
		definition: () => Effect.succeed([]),
		hover: () => Effect.succeed(null),
	};
	const lookup = (
		_root: string,
	): Effect.Effect<LspServer, LspProcessError | TsLspBinaryResolutionError> =>
		Effect.succeed(fakeServer);
	let active = 0;
	let maximumActive = 0;

	const program = Effect.scoped(
		Effect.gen(function* () {
			const resources = yield* RcMap.make({
				lookup,
				capacity: 3,
				idleTimeToLive: "5 minutes",
			});
			const pool = {
				resources,
				admissionLock: Semaphore.makeUnsafe(1),
			} satisfies CodeLspPoolValue;
			const operation = withCodeLspServer(pool, "root", () =>
				Effect.gen(function* () {
					active += 1;
					maximumActive = Math.max(maximumActive, active);
					yield* Effect.promise(
						() => new Promise<void>((resolve) => setTimeout(resolve, 75)),
					);
					active -= 1;
				}),
			);
			yield* Effect.all([operation, operation], {
				concurrency: "unbounded",
			});
		}),
	);

	await Effect.runPromise(program);
	expect(maximumActive).toBe(2);
});

test("different worktree roots use separate live servers", async () => {
	const spawnedRoots: string[] = [];
	let active = 0;
	let maximumActive = 0;
	const lookup = (
		root: string,
	): Effect.Effect<LspServer, LspProcessError | TsLspBinaryResolutionError> =>
		Effect.sync(() => {
			spawnedRoots.push(root);
			return {
				rootPath: root,
				openDocument: () => Effect.void,
				semanticTokensFull: () => Effect.succeed([]),
				references: () => Effect.succeed([]),
				definition: () => Effect.succeed([]),
				hover: () => Effect.succeed(null),
			};
		});

	const program = Effect.scoped(
		Effect.gen(function* () {
			const resources = yield* RcMap.make({
				lookup,
				capacity: 2,
				idleTimeToLive: "5 minutes",
			});
			const pool = {
				resources,
				admissionLock: Semaphore.makeUnsafe(1),
			} satisfies CodeLspPoolValue;
			const operation = (root: string) =>
				withCodeLspServer(pool, root, () =>
					Effect.gen(function* () {
						active += 1;
						maximumActive = Math.max(maximumActive, active);
						yield* Effect.promise(
							() => new Promise<void>((resolve) => setTimeout(resolve, 75)),
						);
						active -= 1;
					}),
				);
			yield* Effect.all([operation("repo-a"), operation("repo-b")], {
				concurrency: "unbounded",
			});
		}),
	);

	await Effect.runPromise(program);
	expect(maximumActive).toBe(2);
	expect(spawnedRoots.sort()).toEqual(["repo-a", "repo-b"]);
});

test("a failed lease is surfaced and the next operation gets a fresh server", async () => {
	const fakeServer: LspServer = {
		rootPath: "root",
		openDocument: () => Effect.void,
		semanticTokensFull: () => Effect.succeed([]),
		references: () => Effect.succeed([]),
		definition: () => Effect.succeed([]),
		hover: () => Effect.succeed(null),
	};
	let lookups = 0;
	const lookup = (
		_root: string,
	): Effect.Effect<LspServer, LspProcessError | TsLspBinaryResolutionError> =>
		Effect.sync(() => {
			lookups += 1;
			return fakeServer;
		});

	const program = Effect.scoped(
		Effect.gen(function* () {
			const resources = yield* RcMap.make({
				lookup,
				capacity: 3,
				idleTimeToLive: "5 minutes",
			});
			const pool = {
				resources,
				admissionLock: Semaphore.makeUnsafe(1),
			} satisfies CodeLspPoolValue;
			const first = yield* Effect.result(
				withCodeLspServer(pool, "root", () =>
					Effect.fail(
						new LspRequestError({
							method: "textDocument/semanticTokens/full",
							reason: "timeout",
							cause: new Error("temporary failure"),
						}),
					),
				),
			);
			const second = yield* withCodeLspServer(pool, "root", () =>
				Effect.succeed("retried"),
			);
			return { first, second };
		}),
	);

	const result = await Effect.runPromise(program);
	expect(result.first._tag).toBe("Failure");
	expect(result.second).toBe("retried");
	expect(lookups).toBe(2);
});

describe("describeCodeIndexFailure", () => {
	test("formats binary resolution and process failures for request errors", () => {
		const binaryFailure = new TsLspBinaryResolutionError({
			strategy: "dev-get-exe-path",
			cause: new Error("missing binary"),
		});
		const spawnFailure = new LspProcessError({
			step: "spawn",
			cause: new Error("ENOENT"),
		});
		const initializeFailure = new LspProcessError({
			step: "initialize",
			cause: new Error("timeout"),
		});
		const requestFailure = new LspRequestError({
			method: "textDocument/references",
			reason: "timeout",
			cause: new Error("deadline exceeded"),
		});

		expect(describeCodeIndexFailure(binaryFailure)).toContain(
			"dev-get-exe-path",
		);
		expect(describeCodeIndexFailure(spawnFailure)).toContain("start");
		expect(describeCodeIndexFailure(initializeFailure)).toContain("initialize");
		expect(describeCodeIndexFailure(requestFailure)).toContain(
			"textDocument/references",
		);
	});
});

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
					{
						line: 0,
						charStart: 6,
						charEnd: 9,
						lineText: "const foo = 1;",
					},
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

	test("builds a padded context window on demand", () => {
		const lines = Array.from({ length: 25 }, (_value, index) => `line${index}`);
		expect(
			buildSourceContext(
				{ path: "a.ts", line: 12 },
				new Map([["a.ts", encode(lines.join("\n"))]]),
			),
		).toEqual({
			startLine: 2,
			lines: lines.slice(2, 23),
		});
	});

	describe("definitionContext", () => {
		test("a definition gets a padded context window (10 lines before, 10 after)", () => {
			const fileContents = new Map([
				[
					"a.ts",
					encode(
						"line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nfunction myFunction() {}\nline11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\nline21\n",
					),
				],
			]);
			const plan = basePlan({
				definition: { path: "a.ts", line: 10, charStart: 9, charEnd: 19 },
			});
			const response = buildReferencesResponse(plan, fileContents);
			expect(response.definitionContext).toEqual({
				startLine: 0,
				lines: [
					"line0",
					"line1",
					"line2",
					"line3",
					"line4",
					"line5",
					"line6",
					"line7",
					"line8",
					"line9",
					"function myFunction() {}",
					"line11",
					"line12",
					"line13",
					"line14",
					"line15",
					"line16",
					"line17",
					"line18",
					"line19",
					"line20",
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

/**
 * Pure line-scan coverage for `buildFileOccurrencesResponse`'s import-line
 * supplement — fast, no LSP process involved. Whether a candidate this scan
 * finds actually *resolves* (the part that talks to a real server) is
 * `test/import-occurrences.test.ts`'s job instead; this only pins which
 * positions get offered up as candidates.
 */
describe("findImportIdentifierSpans", () => {
	const spanText = (
		text: string,
		span: { line: number; charStart: number; charEnd: number },
	) => text.split("\n")[span.line]?.slice(span.charStart, span.charEnd);

	test("finds every binding in a type-only named import", () => {
		const text = 'import type { Greeting, Farewell } from "./values.ts";\n';
		const spans = findImportIdentifierSpans(text);
		expect(spans.map((span) => spanText(text, span))).toEqual([
			"Greeting",
			"Farewell",
		]);
	});

	test("finds the binding in a plain value import", () => {
		const text = 'import { greet } from "./values.ts";\n';
		const spans = findImportIdentifierSpans(text);
		expect(spans.map((span) => spanText(text, span))).toEqual(["greet"]);
	});

	test("finds both sides of an aliased named import, but not the `as` keyword", () => {
		const text = 'import { foo as bar } from "./values.ts";\n';
		const spans = findImportIdentifierSpans(text);
		expect(spans.map((span) => spanText(text, span))).toEqual(["foo", "bar"]);
	});

	test("finds a default import's local binding", () => {
		const text = 'import Greeter from "./values.ts";\n';
		const spans = findImportIdentifierSpans(text);
		expect(spans.map((span) => spanText(text, span))).toEqual(["Greeter"]);
	});

	test("finds a namespace import's local binding, but not the `as` keyword", () => {
		const text = 'import * as values from "./values.ts";\n';
		const spans = findImportIdentifierSpans(text);
		expect(spans.map((span) => spanText(text, span))).toEqual(["values"]);
	});

	test("a side-effect-only import has no bindings to find", () => {
		const text = 'import "./styles.css";\n';
		expect(findImportIdentifierSpans(text)).toEqual([]);
	});

	test("does not treat words inside the module specifier string as candidates", () => {
		const text = 'import { greet } from "./greet-utils.ts";\n';
		const spans = findImportIdentifierSpans(text);
		// Only the binding itself — not "greet" or "utils" from the specifier.
		expect(spans).toHaveLength(1);
		expect(spanText(text, spans[0] as (typeof spans)[number])).toBe("greet");
	});

	test("a multi-line named import block is scanned across every line", () => {
		const text = [
			"import type {",
			"\tLspLocation,",
			"\tLspProcessError,",
			'} from "@repo/code-lsp";',
			"",
		].join("\n");
		const spans = findImportIdentifierSpans(text);
		expect(spans.map((span) => spanText(text, span))).toEqual([
			"LspLocation",
			"LspProcessError",
		]);
	});

	test("does not scan a non-import line, even one that mentions 'import'", () => {
		const text = 'const message = "this is not an import statement";\n';
		expect(findImportIdentifierSpans(text)).toEqual([]);
	});

	test("resumes scanning ordinary code after an import statement closes", () => {
		const text = [
			'import { greet } from "./values.ts";',
			"",
			"export function run() {",
			'\treturn greet("world");',
			"}",
			"",
		].join("\n");
		const spans = findImportIdentifierSpans(text);
		// Only the import's own binding — nothing from the function body below it.
		expect(spans).toHaveLength(1);
		expect(spanText(text, spans[0] as (typeof spans)[number])).toBe("greet");
	});

	test("stops at MAX_IMPORT_SPAN_PROBES for a pathologically large import block", () => {
		const names = Array.from({ length: 500 }, (_, i) => `name${i}`);
		const text = `import {\n${names.map((n) => `\t${n},`).join("\n")}\n} from "./huge.ts";\n`;
		const spans = findImportIdentifierSpans(text);
		expect(spans.length).toBeLessThanOrEqual(200);
		expect(spans.length).toBeGreaterThan(0);
	});
});
