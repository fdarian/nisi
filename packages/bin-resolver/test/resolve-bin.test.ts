import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	findExecutable,
	resolveBin,
	resolvedPath,
} from "../src/resolve-bin.ts";

describe("findExecutable", () => {
	test("returns the first dir/name that exists, in dir order", () => {
		const exists = (path: string) => path === "/b/tool";
		expect(findExecutable("tool", ["/a", "/b", "/c"], exists)).toBe("/b/tool");
	});

	test("returns undefined when no dir has it", () => {
		expect(findExecutable("tool", ["/a", "/b"], () => false)).toBeUndefined();
	});
});

describe("resolveBin", () => {
	const envOverrideVar = "NISI_TEST_BIN_RESOLVER_OVERRIDE";
	let tempDir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bin-resolver-test-"));
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env[envOverrideVar];
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("an explicit env override wins over everything else", () => {
		process.env[envOverrideVar] = "/custom/path/to/tool";
		process.env.PATH = tempDir;
		expect(resolveBin("tool", envOverrideVar)).toBe("/custom/path/to/tool");
	});

	test("resolves via a directory on PATH", () => {
		const binPath = join(tempDir, "my-tool");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.PATH = tempDir;
		expect(resolveBin("my-tool")).toBe(binPath);
	});

	test("falls back to the bare name when nothing on disk matches", () => {
		process.env.PATH = tempDir;
		expect(resolveBin("definitely-not-a-real-tool")).toBe(
			"definitely-not-a-real-tool",
		);
	});

	test("an empty-string override is treated as unset", () => {
		process.env[envOverrideVar] = "";
		const binPath = join(tempDir, "my-tool");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.PATH = tempDir;
		expect(resolveBin("my-tool", envOverrideVar)).toBe(binPath);
	});
});

describe("resolvedPath", () => {
	let originalPath: string | undefined;

	beforeEach(() => {
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
	});

	test("keeps every existing PATH entry, in order", () => {
		process.env.PATH = "/usr/bin:/bin";
		const dirs = resolvedPath().split(":");
		expect(dirs.slice(0, 2)).toEqual(["/usr/bin", "/bin"]);
	});

	test("does not duplicate a well-known dir already on PATH", () => {
		process.env.PATH = "/usr/bin:/opt/homebrew/bin";
		const dirs = resolvedPath().split(":");
		expect(dirs.filter((dir) => dir === "/opt/homebrew/bin")).toHaveLength(1);
	});
});
