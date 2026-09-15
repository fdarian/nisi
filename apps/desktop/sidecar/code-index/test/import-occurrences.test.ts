import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import {
	buildFileOccurrencesResponse,
	buildReferencesPlan,
	CodeLspPool,
} from "../state.ts";

/**
 * Integration test for `buildFileOccurrencesResponse`'s import-line
 * supplement — spawns a real `tsc --lsp --stdio` process against a small
 * fixture project and proves the coverage hole this closes: the semantic-
 * token pass alone (verified, twice, to emit zero tokens on any import
 * line — see `PLAN.md`'s "The hole") would otherwise leave both
 * `import type { Greeting }` and `import { greet }` dark for ⌘-hover.
 */

const FIXTURE_ROOT = join(import.meta.dir, "fixtures", "import-project");
const CONSUMER_PATH = "src/consumer.ts";
const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");
const FILES_FROM_FOUR_PROJECTS = [
	"packages/settings/src/store.ts",
	"packages/git/src/exec.ts",
	"packages/review/src/index.ts",
	"apps/desktop/src/components/code-index/occurrence-index.ts",
] as const;

const TestLayer = CodeLspPool.layer.pipe(Layer.provideMerge(BunServices.layer));

const runWithPool = <A, E>(
	effect: Effect.Effect<A, E, CodeLspPool>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, TestLayer));

const assertDefined = <T>(value: T | undefined, message: string): T => {
	if (value === undefined) throw new Error(message);
	return value;
};

describe("buildFileOccurrencesResponse against a real fixture with imports", () => {
	test("gains occurrences on both the type-only and value import lines, and references from the import site match the usage site", async () => {
		const consumerSource = await Bun.file(
			join(FIXTURE_ROOT, CONSUMER_PATH),
		).text();
		const lines = consumerSource.split("\n");
		// import type { Greeting } from "./values.ts";
		const typeImportLine = 0;
		const typeImportChar = assertDefined(
			lines[typeImportLine],
			"fixture's first line is missing",
		).indexOf("Greeting");
		// import { greet } from "./values.ts";
		const valueImportLine = 1;
		const valueImportChar = assertDefined(
			lines[valueImportLine],
			"fixture's second line is missing",
		).indexOf("greet");
		// The first call site: `return greet(name);` inside `run`.
		const usageLineIndex = lines.findIndex(
			(line, index) => index > valueImportLine && line.includes("greet(name)"),
		);
		const usageLine = assertDefined(
			lines[usageLineIndex],
			"fixture has no usage site for greet",
		);
		const usageChar = usageLine.indexOf("greet(");

		const program = Effect.gen(function* () {
			const occurrences = yield* buildFileOccurrencesResponse(
				FIXTURE_ROOT,
				CONSUMER_PATH,
			);

			const typeImportOccurrence = occurrences.find(
				(o) => o.line === typeImportLine && o.charStart === typeImportChar,
			);
			const valueImportOccurrence = occurrences.find(
				(o) => o.line === valueImportLine && o.charStart === valueImportChar,
			);
			const usageOccurrence = occurrences.find(
				(o) => o.line === usageLineIndex && o.charStart === usageChar,
			);

			const definedValueImportOccurrence = assertDefined(
				valueImportOccurrence,
				"expected an occurrence at the `greet` import specifier — the coverage hole this test guards against",
			);
			const definedUsageOccurrence = assertDefined(
				usageOccurrence,
				"expected the ordinary semantic-token occurrence at greet's usage site",
			);

			const fromImportSite = yield* buildReferencesPlan(
				FIXTURE_ROOT,
				definedValueImportOccurrence.symbolKey,
			);
			const fromUsageSite = yield* buildReferencesPlan(
				FIXTURE_ROOT,
				definedUsageOccurrence.symbolKey,
			);

			return {
				typeImportOccurrence,
				valueImportOccurrence,
				fromImportSite,
				fromUsageSite,
			};
		});

		const result = await runWithPool(program);

		expect(result.typeImportOccurrence).toBeDefined();
		expect(result.valueImportOccurrence).toBeDefined();

		// Same symbol, queried from two different positions — must agree.
		expect(result.fromImportSite.totalReferenceCount).toBe(
			result.fromUsageSite.totalReferenceCount,
		);
		expect(result.fromImportSite.returnedLocations).toEqual(
			result.fromUsageSite.returnedLocations,
		);
		expect(
			result.fromImportSite.returnedLocations.some(
				(location) => location.isDefinition,
			),
		).toBe(true);
		// Sanity: `greet` really does have more than zero references (the
		// definition itself plus every call site), so an empty-both-sides
		// false positive can't slip through the equality checks above.
		expect(result.fromImportSite.totalReferenceCount).toBeGreaterThan(0);
	}, 30_000);

	test("keeps concurrent occurrence requests alive across packages on one root", async () => {
		const program = Effect.all(
			FILES_FROM_FOUR_PROJECTS.map((path) =>
				buildFileOccurrencesResponse(REPO_ROOT, path).pipe(
					Effect.map((occurrences) => ({ path, count: occurrences.length })),
				),
			),
			{ concurrency: "unbounded" },
		);

		const results = await runWithPool(program);
		for (const result of results) {
			expect(
				result.count,
				`${result.path} should have semantic occurrences`,
			).toBeGreaterThan(0);
		}
	}, 30_000);
});
