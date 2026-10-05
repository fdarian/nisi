import { expect, test } from "bun:test";
import { join } from "node:path";

const invoke = (args: string[]) =>
	Bun.spawnSync(
		[process.execPath, join(import.meta.dir, "index.ts"), ...args],
		{ cwd: import.meta.dir, stdout: "pipe", stderr: "pipe" },
	);

test("lazy command path preserves help, version and completions", () => {
	const help = invoke(["--help"]);
	expect(help.exitCode).toBe(0);
	expect(help.stdout.toString()).toContain("nisi");
	expect(help.stdout.toString()).toContain("completion");
	const version = invoke(["--version"]);
	expect(version.exitCode).toBe(0);
	expect(version.stdout.toString()).toContain("0.1.0");
	const completion = invoke(["completion", "zsh"]);
	expect(completion.exitCode).toBe(0);
	expect(completion.stdout.toString()).toContain("_nisi");
});
