import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import {
	decodeIndex,
	definitionsOf,
	displayNameOf,
	documentationOf,
	occurrencesInDocument,
	referencesOf,
} from "../src/decode.ts";
import { symbolKeyOf } from "../src/symbol.ts";

/**
 * A real 6.4 MB index of this repo, produced by an earlier spike run of
 * `scip-typescript index --pnpm-workspaces` — deliberately not committed
 * (see this package's `AGENTS.md`), so this whole file is a no-op when it's
 * absent (a fresh clone, CI, another machine) rather than a failure.
 */
const FIXTURE_PATH = "/tmp/scip-spike/full-workspace.scip";
const hasFixture = existsSync(FIXTURE_PATH);
const itWithFixture = hasFixture ? test : test.skip;

describe("decodeIndex against a real scip-typescript index", () => {
	itWithFixture(
		"decodes without throwing and reports the corpus size established by the spike",
		async () => {
			const bytes = readFileSync(FIXTURE_PATH);
			const index = await Effect.runPromise(decodeIndex(new Uint8Array(bytes)));

			expect(index.documentCount).toBe(298);
		},
	);

	itWithFixture(
		"finds SettingsStore's definition and at least one reference by symbol key",
		async () => {
			const bytes = readFileSync(FIXTURE_PATH);
			const index = await Effect.runPromise(decodeIndex(new Uint8Array(bytes)));

			const path = "packages/settings/src/store.ts";
			const occurrences = occurrencesInDocument(index, path);
			expect(occurrences).toBeDefined();

			const definitionOccurrence = occurrences?.find(
				(occurrence) => occurrence.isDefinition,
			);
			expect(definitionOccurrence).toBeDefined();
			if (definitionOccurrence === undefined) throw new Error("unreachable");

			const displayName = displayNameOf(index, definitionOccurrence.symbolKey);
			const definitions = definitionsOf(index, definitionOccurrence.symbolKey);
			const references = referencesOf(index, definitionOccurrence.symbolKey);
			const documentation = documentationOf(
				index,
				definitionOccurrence.symbolKey,
			);

			expect(typeof displayName).toBe("string");
			expect(definitions.length).toBeGreaterThan(0);
			expect(references.length).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(documentation)).toBe(true);
		},
	);

	itWithFixture(
		"keys every 'local ' symbol by its own document — no cross-document collisions",
		async () => {
			const bytes = readFileSync(FIXTURE_PATH);
			const index = await Effect.runPromise(decodeIndex(new Uint8Array(bytes)));

			// Two arbitrary documents that both plausibly declare a `local 0` —
			// if `symbolKeyOf` ever regressed to keying locals by symbol string
			// alone, their definitions would collide into one entry covering
			// both files, which this catches directly rather than by counting.
			const [pathA, pathB] = [...index.occurrencesByPath.keys()]
				.filter((path) => path.endsWith(".ts"))
				.slice(0, 2);
			expect(pathA).toBeDefined();
			expect(pathB).toBeDefined();
			if (pathA === undefined || pathB === undefined)
				throw new Error("unreachable");

			const keyA = symbolKeyOf(pathA, "local 0");
			const keyB = symbolKeyOf(pathB, "local 0");
			expect(keyA).not.toBe(keyB);
		},
	);
});
