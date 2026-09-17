import { afterAll, expect, test } from "bun:test";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { resolveTsLspBinary } from "../src/binary.ts";
import {
	ensureTsLspBinary,
	TS_LSP_VERSION,
	TsLspBinaryInstallError,
} from "../src/ts-lsp-download.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "nisi-code-lsp-binary-test-"));

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

test("a tarball digest mismatch fails before extraction", async () => {
	const result = await Effect.runPromise(
		ensureTsLspBinary(join(TEST_ROOT, "digest-cache"), {
			downloadTarball: () => Effect.succeed(new Uint8Array([1, 2, 3])),
		}).pipe(
			Effect.map(() => "installed" as const),
			Effect.catchTag("TsLspBinaryInstallError", (error) =>
				Effect.succeed(error),
			),
			Effect.provide(BunServices.layer),
		),
	);
	if (result === "installed") {
		throw new Error("the invalid tarball unexpectedly installed");
	}
	expect(result).toBeInstanceOf(TsLspBinaryInstallError);
	expect(result.reason).toBe("integrity-mismatch");
	expect(String(result.cause)).toContain("SHA-512 mismatch");
});

test("a worktree TypeScript 7 without its native package falls through to cache", async () => {
	const rootPath = join(TEST_ROOT, "worktree");
	const typescriptDir = join(rootPath, "node_modules", "typescript");
	const typescriptLibDir = join(typescriptDir, "lib");
	const cacheDir = join(TEST_ROOT, "fallback-cache");
	const cacheVersionDir = join(cacheDir, TS_LSP_VERSION);
	mkdirSync(typescriptLibDir, { recursive: true });
	mkdirSync(cacheVersionDir, { recursive: true });
	writeFileSync(
		join(typescriptDir, "package.json"),
		JSON.stringify({
			name: "typescript",
			version: "7.0.2",
			type: "module",
			bin: { tsc: "./bin/tsc" },
		}),
	);
	copyFileSync(
		join(
			import.meta.dir,
			"..",
			"node_modules",
			"typescript",
			"lib",
			"getExePath.js",
		),
		join(typescriptLibDir, "getExePath.js"),
	);
	writeFileSync(join(cacheVersionDir, "tsc"), "cached binary");
	writeFileSync(
		join(cacheVersionDir, "lib.d.ts"),
		"declare const cached: unique symbol;",
	);

	const binary = await Effect.runPromise(
		resolveTsLspBinary(rootPath, cacheDir).pipe(
			Effect.provide(BunServices.layer),
		),
	);
	expect(binary).toBe(join(cacheVersionDir, "tsc"));
});
