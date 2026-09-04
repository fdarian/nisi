import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { type LspServer, spawnLspServer } from "../src/client.ts";

/**
 * Integration tests — these spawn the real `tsc --lsp --stdio` binary
 * (resolved via `binary.ts`'s dev path, since `bun test` never runs
 * compiled) and talk to it over stdio. Slower and less hermetic than the
 * pure unit tests in `protocol.test.ts`/`semantic-tokens.test.ts`, but
 * nothing short of a real server proves the framing, correlation, and
 * request/response wiring in `client.ts` actually work end to end.
 */

const TINY_PROJECT_ROOT = join(import.meta.dir, "fixtures", "tiny-project");
const GREETER_TS = join(TINY_PROJECT_ROOT, "src", "greeter.ts");
const MAIN_TS = join(TINY_PROJECT_ROOT, "src", "main.ts");

const withServer = <A, E>(
	rootPath: string,
	use: (server: LspServer) => Effect.Effect<A, E>,
): Promise<A> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const server = yield* spawnLspServer(rootPath);
				return yield* use(server);
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);

describe("spawnLspServer against a tiny self-contained fixture", () => {
	test("hover on the greet function's declaration returns its signature and doc comment", async () => {
		const hover = await withServer(TINY_PROJECT_ROOT, (server) =>
			server.hover(GREETER_TS, { line: 1, character: 16 }),
		);
		expect(hover).not.toBeNull();
		expect(hover?.contents).toContain("function greet(name: string): string");
		expect(hover?.contents).toContain("Builds a greeting for");
	});

	test("definition from a call site resolves back to the declaration", async () => {
		// main.ts line 3 (0-based): `\treturn greet("world");` — "greet" starts at character 8.
		const locations = await withServer(TINY_PROJECT_ROOT, (server) =>
			server.definition(MAIN_TS, { line: 3, character: 9 }),
		);
		expect(locations).toEqual([
			{
				path: GREETER_TS,
				range: {
					start: { line: 1, character: 16 },
					end: { line: 1, character: 21 },
				},
			},
		]);
	});

	test("references from the declaration finds the definition, the import specifier, and every call site", async () => {
		const locations = await withServer(TINY_PROJECT_ROOT, (server) =>
			server.references(GREETER_TS, { line: 1, character: 16 }),
		);
		// 1 declaration (greeter.ts) + 1 import specifier + 2 call sites (main.ts).
		expect(locations).toHaveLength(4);
		const byPath = new Map<string, number>();
		for (const location of locations) {
			byPath.set(location.path, (byPath.get(location.path) ?? 0) + 1);
		}
		expect(byPath.get(GREETER_TS)).toBe(1);
		expect(byPath.get(MAIN_TS)).toBe(3);
	});

	test("references at an out-of-range position answers a clean empty array", async () => {
		const locations = await withServer(TINY_PROJECT_ROOT, (server) =>
			server.references(GREETER_TS, { line: 999, character: 0 }),
		);
		expect(locations).toEqual([]);
	});

	test("semanticTokensFull decodes the greet declaration and its parameter", async () => {
		const tokens = await withServer(TINY_PROJECT_ROOT, (server) =>
			server.semanticTokensFull(GREETER_TS),
		);

		const greetToken = tokens.find(
			(t) => t.range.start.line === 1 && t.range.start.character === 16,
		);
		expect(greetToken?.tokenType).toBe("function");
		expect(greetToken?.tokenModifiers).toContain("declaration");

		const nameParamToken = tokens.find(
			(t) => t.tokenType === "parameter" && t.range.start.line === 1,
		);
		expect(nameParamToken).toBeDefined();
	});

	test("two queries against the same server both succeed (process is reused, not respawned)", async () => {
		const [hover, locations] = await withServer(TINY_PROJECT_ROOT, (server) =>
			Effect.all([
				server.hover(GREETER_TS, { line: 1, character: 16 }),
				server.references(GREETER_TS, { line: 1, character: 16 }),
			]),
		);
		expect(hover).not.toBeNull();
		expect(locations).toHaveLength(4);
	});
});

describe("spawnLspServer against the real repo", () => {
	// This package lives at <repoRoot>/packages/code-lsp/test/client.test.ts.
	const repoRoot = join(import.meta.dir, "..", "..", "..");
	const settingsRoot = join(repoRoot, "packages", "settings");
	const storeTs = join(settingsRoot, "src", "store.ts");

	test("references on SettingsStore's declaration finds exactly 24 references across 4 files, scoped to its own tsconfig project", async () => {
		// Line 124, column 14 (1-based) === { line: 123, character: 13 } (0-based)
		// on `export class SettingsStore extends ...` — verified against a
		// fresh server rooted at packages/settings alone (not the repo root)
		// before writing this test; see this package's AGENTS.md on why the
		// server root matters for a stable count (gotcha 4).
		const locations = await withServer(settingsRoot, (server) =>
			server.references(storeTs, { line: 123, character: 13 }),
		);

		expect(locations).toHaveLength(24);

		const byPath = new Map<string, number>();
		for (const location of locations) {
			byPath.set(location.path, (byPath.get(location.path) ?? 0) + 1);
		}
		expect(byPath.size).toBe(4);
		expect(byPath.get(storeTs)).toBe(4);
		expect(byPath.get(join(settingsRoot, "src", "index.ts"))).toBe(1);
		expect(byPath.get(join(settingsRoot, "test", "fixtures.ts"))).toBe(2);
		expect(byPath.get(join(settingsRoot, "test", "store.test.ts"))).toBe(17);
	}, 30_000);
});
