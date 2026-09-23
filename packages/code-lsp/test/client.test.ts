import { afterAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { type LspServer, spawnLspServer } from "../src/client.ts";
import type { LspLocation } from "../src/protocol.ts";
import { TS_LSP_VERSION } from "../src/ts-lsp-download.ts";

/**
 * Integration tests — these spawn the real `tsc --lsp --stdio` binary
 * (resolved from a test-populated pinned cache) and talk to it over stdio.
 * Slower and less hermetic than the
 * pure unit tests in `protocol.test.ts`/`semantic-tokens.test.ts`, but
 * nothing short of a real server proves the framing, correlation, and
 * request/response wiring in `client.ts` actually work end to end.
 */

const TINY_PROJECT_ROOT = join(import.meta.dir, "fixtures", "tiny-project");
const GREETER_TS = join(TINY_PROJECT_ROOT, "src", "greeter.ts");
const MAIN_TS = join(TINY_PROJECT_ROOT, "src", "main.ts");
const TEST_CACHE_DIR = mkdtempSync(join(tmpdir(), "nisi-code-lsp-test-"));

const populateTestCache = async (): Promise<void> => {
	const typescriptDir = realpathSync(
		join(import.meta.dir, "..", "node_modules", "typescript"),
	);
	const getExePathModule: { readonly default: () => string } = await import(
		pathToFileURL(join(typescriptDir, "lib", "getExePath.js")).href
	);
	const installedBinary = getExePathModule.default();
	const installedLibDir = dirname(installedBinary);
	const targetDir = join(TEST_CACHE_DIR, TS_LSP_VERSION);
	mkdirSync(targetDir, { recursive: true });
	copyFileSync(installedBinary, join(targetDir, basename(installedBinary)));
	for (const name of readdirSync(installedLibDir)) {
		if (!name.endsWith(".d.ts")) continue;
		copyFileSync(join(installedLibDir, name), join(targetDir, name));
	}
	chmodSync(join(targetDir, basename(installedBinary)), 0o755);
};

await populateTestCache();
afterAll(() => rmSync(TEST_CACHE_DIR, { recursive: true, force: true }));

const withServer = <A, E>(
	rootPath: string,
	use: (server: LspServer) => Effect.Effect<A, E>,
): Promise<A> =>
	Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const server = yield* spawnLspServer(rootPath, TEST_CACHE_DIR);
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
	const settingsStore = join(
		repoRoot,
		"packages",
		"settings",
		"src",
		"store.ts",
	);
	const settingsFiles = [
		settingsStore,
		join(repoRoot, "packages", "settings", "src", "index.ts"),
		join(repoRoot, "packages", "settings", "test", "fixtures.ts"),
		join(repoRoot, "packages", "settings", "test", "store.test.ts"),
	] as const;
	const sidecarFiles = [
		join(repoRoot, "apps", "desktop", "sidecar", "store.ts"),
		join(repoRoot, "apps", "desktop", "sidecar", "test", "store.test.ts"),
		join(repoRoot, "apps", "desktop", "sidecar", "live-poll.ts"),
		join(repoRoot, "apps", "desktop", "sidecar", "services.ts"),
		join(repoRoot, "apps", "desktop", "sidecar", "index.ts"),
		join(repoRoot, "apps", "desktop", "sidecar", "http.ts"),
		join(repoRoot, "apps", "desktop", "sidecar", "walkthrough", "context.ts"),
	] as const;
	const relevantFiles = [...settingsFiles, ...sidecarFiles];
	const nestedTokenFiles = [
		join(repoRoot, "packages", "settings", "src", "store.ts"),
		join(repoRoot, "packages", "review", "src", "index.ts"),
		join(
			repoRoot,
			"apps",
			"desktop",
			"src",
			"features",
			"pull-request",
			"data",
			"session-ui-store.tsx",
		),
		join(repoRoot, "apps", "desktop", "sidecar", "http.ts"),
	] as const;

	const openDocuments = (
		server: LspServer,
		paths: ReadonlyArray<string>,
	): Effect.Effect<void> =>
		Effect.forEach(
			paths,
			(path) =>
				Effect.promise(() => Bun.file(path).text()).pipe(
					Effect.flatMap((text) => server.openDocument(path, text)),
				),
			{ discard: true },
		);

	const referencesAfterOpening = (
		paths: ReadonlyArray<string>,
	): Promise<ReadonlyArray<LspLocation>> =>
		withServer(repoRoot, (server) =>
			Effect.gen(function* () {
				yield* openDocuments(server, paths);
				return yield* server.references(settingsStore, {
					line: 131,
					character: 13,
				});
			}),
		);

	const countByPath = (
		locations: ReadonlyArray<LspLocation>,
	): Map<string, number> => {
		const byPath = new Map<string, number>();
		for (const location of locations) {
			byPath.set(location.path, (byPath.get(location.path) ?? 0) + 1);
		}
		return byPath;
	};

	test("root-scoped semantic tokens cover nested packages without didOpen", async () => {
		const counts = await withServer(repoRoot, (server) =>
			Effect.forEach(
				nestedTokenFiles,
				(path) =>
					server
						.semanticTokensFull(path)
						.pipe(Effect.map((tokens) => tokens.length)),
				{ concurrency: "unbounded" },
			),
		);

		for (const count of counts) expect(count).toBeGreaterThan(0);
	});

	test("root-scoped references stay complete and order-independent across packages", async () => {
		const cold = await referencesAfterOpening(relevantFiles);
		const warm = await referencesAfterOpening([...relevantFiles].reverse());

		expect(cold).toHaveLength(46);
		expect(warm).toHaveLength(cold.length);
		expect(warm).toEqual(cold);

		const byPath = countByPath(cold);
		expect(byPath).toEqual(
			new Map([
				[join(repoRoot, "apps", "desktop", "sidecar", "http.ts"), 5],
				[join(repoRoot, "apps", "desktop", "sidecar", "index.ts"), 2],
				[join(repoRoot, "apps", "desktop", "sidecar", "live-poll.ts"), 2],
				[join(repoRoot, "apps", "desktop", "sidecar", "services.ts"), 2],
				[join(repoRoot, "apps", "desktop", "sidecar", "store.ts"), 3],
				[
					join(repoRoot, "apps", "desktop", "sidecar", "test", "store.test.ts"),
					5,
				],
				[
					join(
						repoRoot,
						"apps",
						"desktop",
						"sidecar",
						"walkthrough",
						"context.ts",
					),
					3,
				],
				[join(repoRoot, "packages", "settings", "src", "index.ts"), 1],
				[settingsStore, 4],
				[join(repoRoot, "packages", "settings", "test", "fixtures.ts"), 2],
				[join(repoRoot, "packages", "settings", "test", "store.test.ts"), 17],
			]),
		);
	}, 30_000);
});
