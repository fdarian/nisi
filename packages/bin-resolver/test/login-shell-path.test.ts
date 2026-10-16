import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeLoginShellDirs } from "../src/login-shell-path.ts";

const ZSH = "/bin/zsh";

describe.skipIf(!existsSync(ZSH))("probeLoginShellDirs", () => {
	let zdotdir: string;
	let originalShell: string | undefined;
	let originalZdotdir: string | undefined;

	beforeEach(() => {
		zdotdir = mkdtempSync(join(tmpdir(), "nisi-zdotdir-"));
		originalShell = process.env.SHELL;
		originalZdotdir = process.env.ZDOTDIR;
		process.env.SHELL = ZSH;
		process.env.ZDOTDIR = zdotdir;
	});

	afterEach(() => {
		if (originalShell === undefined) delete process.env.SHELL;
		else process.env.SHELL = originalShell;
		if (originalZdotdir === undefined) delete process.env.ZDOTDIR;
		else process.env.ZDOTDIR = originalZdotdir;
		rmSync(zdotdir, { recursive: true, force: true });
	});

	test("returns the PATH the rc files build, ignoring rc chatter", () => {
		writeFileSync(
			join(zdotdir, ".zshrc"),
			'echo "welcome banner"\nexport PATH="/nisi-test/one:/nisi-test/two:$PATH"\n',
		);

		const dirs = probeLoginShellDirs();

		expect(dirs.slice(0, 2)).toEqual(["/nisi-test/one", "/nisi-test/two"]);
		expect(dirs.every((dir) => dir.startsWith("/"))).toBe(true);
	});

	test("gives up on a slow rc at the timeout instead of waiting for it", () => {
		// `sleep` is a grandchild of the shell; with a
		// captured stdout pipe it would keep the call blocked for its full 6s.
		writeFileSync(join(zdotdir, ".zshrc"), "sleep 6\n");

		const start = performance.now();
		const dirs = probeLoginShellDirs(500);
		const elapsed = performance.now() - start;

		expect(dirs).toEqual([]);
		expect(elapsed).toBeLessThan(3_000);
	});
});
