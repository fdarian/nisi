import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHarnessAvailability } from "../availability.ts";

describe("checkHarnessAvailability", () => {
	let tempDir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "harness-availability-test-"));
		originalPath = process.env.PATH;
		process.env.PATH = tempDir;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env.NISI_CODEX_BIN;
		delete process.env.NISI_CLAUDE_BIN;
		delete process.env.NISI_OPENCODE_BIN;
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("pi is always available — it's a bundled library, not a CLI", () => {
		expect(checkHarnessAvailability("pi")).toEqual({
			available: true,
			binaryPath: null,
		});
	});

	test("codex is unavailable when its binary is nowhere to be found", () => {
		// An explicit override to a missing path is deterministic regardless of
		// this machine's real installs — `PATH` alone isn't enough to force
		// "not found," since `checkBinAvailability` still checks well-known
		// install dirs (e.g. `/opt/homebrew/bin`) that may genuinely have codex
		// installed on a dev machine.
		process.env.NISI_CODEX_BIN = join(tempDir, "does-not-exist");
		expect(checkHarnessAvailability("codex")).toEqual({
			available: false,
			binaryPath: null,
		});
	});

	test("codex is available once NISI_CODEX_BIN points at a real file", () => {
		const binPath = join(tempDir, "codex");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.NISI_CODEX_BIN = binPath;

		expect(checkHarnessAvailability("codex")).toEqual({
			available: true,
			binaryPath: binPath,
		});
	});

	test("claude-code and opencode resolve independently through their own env vars", () => {
		const claudePath = join(tempDir, "claude");
		writeFileSync(claudePath, "#!/bin/sh\n");
		process.env.NISI_CLAUDE_BIN = claudePath;
		process.env.NISI_OPENCODE_BIN = join(tempDir, "does-not-exist");

		expect(checkHarnessAvailability("claude-code")).toEqual({
			available: true,
			binaryPath: claudePath,
		});
		expect(checkHarnessAvailability("opencode")).toEqual({
			available: false,
			binaryPath: null,
		});
	});
});
