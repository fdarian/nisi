import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessInfo } from "@repo/sidecar-api";
import { Effect } from "effect";
import { listHarnesses } from "../harnesses.ts";
import { createModelDiscoveryCache } from "../model-discovery.ts";

/**
 * `listHarnesses` composes a live `checkHarnessAvailability` (real
 * filesystem check, driven here through `NISI_CODEX_BIN` so the test
 * controls it without touching the real machine's installs) with
 * `model-discovery.ts`'s cache (injected via `opts.cache` so nothing here
 * touches the shared production singleton, or a real subprocess — every
 * `discover*Models` call would otherwise try to spawn a real CLI). Pi is the
 * one harness never gated on a resolvable binary (see `availability.ts`), so
 * every scenario here uses codex as the stand-in "has a CLI" harness.
 */
describe("listHarnesses — availability composition", () => {
	let tempDir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "list-harnesses-test-"));
		originalPath = process.env.PATH;
		process.env.PATH = tempDir;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env.NISI_CODEX_BIN;
		rmSync(tempDir, { recursive: true, force: true });
	});

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
		const cache = createModelDiscoveryCache();

		const infos = await Effect.runPromise(
			listHarnesses(new Set(["codex"]), { cache }),
		);

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

		const cache = createModelDiscoveryCache();
		// Prime the cache directly with a successful discovery — standing in
		// for "codex was available a moment ago and its model list is cached."
		await Effect.runPromise(
			cache.get("codex", Effect.succeed([{ id: "m", label: "M" }])),
		);

		// The binary vanishes (env override now points nowhere real).
		process.env.NISI_CODEX_BIN = join(tempDir, "does-not-exist");

		const infos = await Effect.runPromise(
			listHarnesses(new Set(["codex"]), { cache }),
		);
		const codex = getCodex(infos);
		expect(codex.available).toBe(false);
		expect(codex.modelsStatus).toBe("unavailable");
		expect(codex.models).toEqual([]);
	});

	test("available and enabled runs discovery normally", async () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		const cache = createModelDiscoveryCache();
		const infos = await Effect.runPromise(
			listHarnesses(new Set(["codex"]), { cache }),
		);
		const codex = getCodex(infos);
		// Real `discoverCodexModels()` will fail against this fake binary (not
		// a real codex CLI) — the point of this test is only that discovery is
		// *attempted* (available+enabled), landing on the cache's own
		// no-prior-success fallback rather than being short-circuited to
		// unavailable before ever trying.
		expect(codex.available).toBe(true);
		expect(codex.binaryPath).toBe(binPath);
	});

	test("disabled harnesses report unavailable models regardless of binary presence", async () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		const cache = createModelDiscoveryCache();
		const infos = await Effect.runPromise(
			listHarnesses(new Set([]), { cache }),
		);
		const codex = getCodex(infos);
		expect(codex.enabled).toBe(false);
		expect(codex.available).toBe(true);
		expect(codex.modelsStatus).toBe("unavailable");
		expect(codex.models).toEqual([]);
	});

	test("force is threaded through to the injected cache", async () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		let discoverCalls = 0;
		const cache = createModelDiscoveryCache();
		const discover = Effect.sync(() => {
			discoverCalls++;
			return [{ id: `m${discoverCalls}`, label: `M${discoverCalls}` }];
		});

		await Effect.runPromise(cache.get("codex", discover));
		expect(discoverCalls).toBe(1);

		// A second `listHarnesses` call within the TTL, forced — must re-run
		// discovery rather than serving the cache hit.
		await Effect.runPromise(
			listHarnesses(new Set(["codex"]), {
				cache: {
					get: (_id, _discover, opts) => cache.get("codex", discover, opts),
				},
				force: true,
			}),
		);
		expect(discoverCalls).toBe(2);
	});
});
