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
import { getHarnessModels } from "../models.ts";

describe("harness presence and model discovery", () => {
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
		if (codex === undefined) throw new Error("codex missing from harness list");
		return codex;
	};

	test("presence stays live and independent of the enabled setting", () => {
		process.env.NISI_CODEX_BIN = join(tempDir, "codex");
		expect(getCodex(listHarnesses(new Set(["codex"])))).toMatchObject({
			enabled: true,
			available: false,
			binaryPath: null,
		});

		writeFileSync(process.env.NISI_CODEX_BIN, "#!/bin/sh\n");
		expect(getCodex(listHarnesses(new Set()))).toMatchObject({
			enabled: false,
			available: true,
			binaryPath: process.env.NISI_CODEX_BIN,
		});
		expect(listHarnesses(null)).toHaveLength(4);
		expect(listHarnesses(null).every((info) => info.enabled)).toBe(true);
	});

	test("model requests check presence independently and forced requests bypass a fresh cache hit", async () => {
		const binPath = join(tempDir, "codex");
		process.env.NISI_CODEX_BIN = binPath;
		const dataDir = mkdtempSync(join(tmpdir(), "harness-models-test-"));
		const layer = HarnessModelCache.layer.pipe(
			Layer.provideMerge(SqliteDb.layer),
			Layer.provideMerge(BunServices.layer),
			Layer.provide(
				ConfigProvider.layer(
					ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
				),
			),
		);
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const absent = yield* getHarnessModels("codex");
					expect(absent).toEqual({ models: [], status: "unavailable" });
					writeFileSync(binPath, "#!/bin/sh\n");
					const cache = yield* HarnessModelCache;
					yield* cache.get("codex", () =>
						Effect.succeed([{ id: "primed", label: "Primed" }]),
					);
					const cached = yield* getHarnessModels("codex");
					expect(cached).toEqual({
						models: [{ id: "primed", label: "Primed" }],
						status: "fresh",
					});
					const forced = yield* getHarnessModels("codex", true);
					expect(forced.status).toBe("stale");
					process.env.NISI_CODEX_BIN = join(tempDir, "removed");
					expect(yield* getHarnessModels("codex")).toEqual({
						models: [],
						status: "unavailable",
					});
				}).pipe(Effect.provide(layer)),
			);
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});
});
