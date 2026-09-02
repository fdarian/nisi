import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import type { HarnessInfo } from "@repo/sidecar-api";
import { ConfigProvider, Effect, Layer } from "effect";
import { listHarnesses } from "../harnesses.ts";
import { HarnessModelCache } from "../model-store.ts";

/**
 * `listHarnesses` composes a live `checkHarnessAvailability` (real
 * filesystem check, driven here through `NISI_CODEX_BIN` so the test
 * controls it without touching the real machine's installs) with
 * `HarnessModelCache` (`../model-store.ts`) — a real `SqliteDb` connection
 * pinned at a throwaway `NISI_DATA_DIR` via `withLayer`, never the shared
 * production instance. The cache's own fresh/stale/backoff/single-flight
 * semantics are `model-store.test.ts`'s job; this file only covers how
 * `listHarnesses` composes availability with whatever the cache reports —
 * `DISCOVER_MODELS[id]` is always the real `discoverCodexModels` (a real
 * subprocess spawn) here, so every scenario points `NISI_CODEX_BIN` at a
 * fake, non-functional shell script rather than a real CLI: discovery is
 * *attempted*, but always lands on the cache's own no-prior-success
 * fallback, which is all these tests need.
 */
describe("listHarnesses — availability composition", () => {
	let tempDir: string;
	let dataDir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "list-harnesses-test-"));
		dataDir = mkdtempSync(join(tmpdir(), "list-harnesses-data-"));
		originalPath = process.env.PATH;
		process.env.PATH = tempDir;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env.NISI_CODEX_BIN;
		rmSync(tempDir, { recursive: true, force: true });
		rmSync(dataDir, { recursive: true, force: true });
	});

	const withLayer = <A>(
		effect: Effect.Effect<A, never, HarnessModelCache>,
	): Promise<A> =>
		Effect.runPromise(
			effect.pipe(
				Effect.provide(
					HarnessModelCache.layer.pipe(
						Layer.provideMerge(SqliteDb.layer),
						Layer.provideMerge(BunServices.layer),
						Layer.provide(
							ConfigProvider.layer(
								ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
							),
						),
					),
				),
			),
		);

	const getCodex = (infos: ReadonlyArray<HarnessInfo>) => {
		const codex = infos.find((info) => info.id === "codex");
		if (codex === undefined)
			throw new Error("codex missing from listHarnesses result");
		return codex;
	};

	test("an unavailable harness reports unavailable and skips discovery entirely, even when enabled", async () => {
		// An explicit override to a missing path is deterministic regardless of
		// this machine's real installs — see `availability.test.ts`'s comment on
		// why `PATH` alone can't force "not found" here.
		process.env.NISI_CODEX_BIN = join(tempDir, "does-not-exist");

		const infos = await withLayer(listHarnesses(new Set(["codex"])));

		const codex = getCodex(infos);
		expect(codex.enabled).toBe(true);
		expect(codex.available).toBe(false);
		expect(codex.binaryPath).toBeNull();
		expect(codex.modelsStatus).toBe("unavailable");
		expect(codex.models).toEqual([]);
	});

	test("a harness that was available (and cached) but has since lost its binary reports unavailable, not stale", async () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		// Prime the cache directly with a successful discovery — standing in
		// for "codex was available a moment ago and its model list is cached."
		await withLayer(
			Effect.gen(function* () {
				const cache = yield* HarnessModelCache;
				yield* cache.get("codex", () =>
					Effect.succeed([{ id: "m", label: "M" }]),
				);
			}),
		);

		// The binary vanishes (env override now points nowhere real).
		process.env.NISI_CODEX_BIN = join(tempDir, "does-not-exist");

		const infos = await withLayer(listHarnesses(new Set(["codex"])));
		const codex = getCodex(infos);
		expect(codex.available).toBe(false);
		expect(codex.modelsStatus).toBe("unavailable");
		expect(codex.models).toEqual([]);
	});

	test("available and enabled runs discovery normally", async () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		const infos = await withLayer(listHarnesses(new Set(["codex"])));
		const codex = getCodex(infos);
		// Real `discoverCodexModels()` will fail against this fake binary (not
		// a real codex CLI) — the point of this test is only that discovery is
		// *attempted* (available+enabled), landing on the cache's own
		// no-prior-success fallback rather than being short-circuited to
		// unavailable before ever trying.
		expect(codex.available).toBe(true);
		expect(codex.binaryPath).toBe(binPath);
		expect(codex.modelsStatus).toBe("unavailable");
	});

	test("disabled harnesses report unavailable models regardless of binary presence", async () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		const infos = await withLayer(listHarnesses(new Set([])));
		const codex = getCodex(infos);
		expect(codex.enabled).toBe(false);
		expect(codex.available).toBe(true);
		expect(codex.modelsStatus).toBe("unavailable");
		expect(codex.models).toEqual([]);
	});
});
