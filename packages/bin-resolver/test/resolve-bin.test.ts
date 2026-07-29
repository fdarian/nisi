import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLoginShellPathCache,
	probeLoginShellDirs,
} from "../src/login-shell-path.ts";
import {
	checkBinAvailability,
	findExecutable,
	resolveBin,
	resolvedPath,
} from "../src/resolve-bin.ts";

/**
 * `resolveBin`/`checkBinAvailability`/`resolvedPath` share one module-level
 * login-shell memo, and a lookup that misses `PATH` would otherwise spawn the
 * developer's real shell — seconds of wall clock, and an answer that differs
 * per machine. An empty `SHELL` makes the probe a documented no-op, and
 * warming the memo here freezes that empty result for the whole file, so
 * every test below exercises only the `PATH`/well-known layers it's about.
 * `createLoginShellPathCache`'s own tests use isolated instances with stub
 * probes, so they still cover the memoization itself.
 */
beforeAll(() => {
	process.env.SHELL = "";
	resolvedPath();
});

describe("createLoginShellPathCache", () => {
	test("probes once, then serves the memo", () => {
		let calls = 0;
		const cache = createLoginShellPathCache(() => {
			calls += 1;
			return ["/probed"];
		});
		expect(cache.get()).toEqual(["/probed"]);
		expect(cache.get()).toEqual(["/probed"]);
		expect(calls).toBe(1);
	});

	test("refresh re-probes and replaces the memo", () => {
		let calls = 0;
		const cache = createLoginShellPathCache(() => {
			calls += 1;
			return [`/probe-${calls}`];
		});
		expect(cache.get()).toEqual(["/probe-1"]);
		expect(cache.refresh()).toEqual(["/probe-2"]);
		expect(cache.get()).toEqual(["/probe-2"]);
		expect(calls).toBe(2);
	});

	test("an empty probe result is still memoized, not retried on every call", () => {
		let calls = 0;
		const cache = createLoginShellPathCache(() => {
			calls += 1;
			return [];
		});
		cache.get();
		cache.get();
		expect(calls).toBe(1);
	});
});

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

	test("dedupes a directory PATH itself lists twice", () => {
		process.env.PATH = "/usr/bin:/bin:/usr/bin";
		const dirs = resolvedPath().split(":");
		expect(dirs.filter((dir) => dir === "/usr/bin")).toHaveLength(1);
	});
});

describe("probeLoginShellDirs", () => {
	let tempDir: string;
	let originalShell: string | undefined;

	/**
	 * A stand-in for the user's login shell: it accepts the same
	 * `-l -i -c <script>` invocation and really runs that script, but under a
	 * `PATH` this test controls. That keeps the assertion about the parts
	 * that are ours — the flags, the delimiter framing, the split — rather
	 * than about whatever the developer's own `.zshrc` happens to export.
	 */
	const writeFakeShell = (body: string): string => {
		const shellPath = join(tempDir, "fake-shell");
		writeFileSync(shellPath, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
		return shellPath;
	};

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bin-resolver-probe-test-"));
		originalShell = process.env.SHELL;
	});

	afterEach(() => {
		process.env.SHELL = originalShell;
		rmSync(tempDir, { recursive: true, force: true });
	});

	// `/usr/bin` stays on the fake shell's PATH because the probe script calls
	// `printenv`, exactly as a real login shell would have it.
	test("returns the login shell's own PATH entries, in order", () => {
		process.env.SHELL = writeFakeShell(
			'export PATH=/fake/shim:/usr/bin:/fake/tools\nexec /bin/bash -c "$4"',
		);
		expect(probeLoginShellDirs()).toEqual([
			"/fake/shim",
			"/usr/bin",
			"/fake/tools",
		]);
	});

	test("ignores rc-file chatter printed around the delimited PATH", () => {
		process.env.SHELL = writeFakeShell(
			[
				'echo "Welcome to your shell!"',
				"export PATH=/fake/shim:/usr/bin",
				'exec /bin/bash -c "$4"',
			].join("\n"),
		);
		expect(probeLoginShellDirs()).toEqual(["/fake/shim", "/usr/bin"]);
	});

	test("a shell that fails degrades to no extra dirs rather than throwing", () => {
		process.env.SHELL = writeFakeShell("exit 1");
		expect(probeLoginShellDirs()).toEqual([]);
	});

	test("no SHELL means no probe at all", () => {
		process.env.SHELL = "";
		expect(probeLoginShellDirs()).toEqual([]);
	});
});

describe("checkBinAvailability", () => {
	const envOverrideVar = "NISI_TEST_BIN_AVAILABILITY_OVERRIDE";
	let tempDir: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "bin-resolver-availability-test-"));
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		process.env.PATH = originalPath;
		delete process.env[envOverrideVar];
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("reports available with the resolved path when found on PATH", () => {
		const binPath = join(tempDir, "my-tool");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.PATH = tempDir;
		expect(checkBinAvailability("my-tool")).toEqual({
			available: true,
			path: binPath,
		});
	});

	test("reports unavailable, not a bare-name fallback, when nothing on disk matches", () => {
		process.env.PATH = tempDir;
		expect(checkBinAvailability("definitely-not-a-real-tool")).toEqual({
			available: false,
			path: null,
		});
	});

	test("an env override to a real file is available", () => {
		const binPath = join(tempDir, "custom-tool");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env[envOverrideVar] = binPath;
		process.env.PATH = tempDir;
		expect(checkBinAvailability("my-tool", envOverrideVar)).toEqual({
			available: true,
			path: binPath,
		});
	});

	test("an env override to a missing file is unavailable — unlike resolveBin, it isn't trusted blindly", () => {
		process.env[envOverrideVar] = join(tempDir, "does-not-exist");
		process.env.PATH = tempDir;
		expect(checkBinAvailability("my-tool", envOverrideVar)).toEqual({
			available: false,
			path: null,
		});
	});

	test("an empty-string override is treated as unset, falling through to PATH", () => {
		process.env[envOverrideVar] = "";
		const binPath = join(tempDir, "my-tool");
		writeFileSync(binPath, "#!/bin/sh\n");
		process.env.PATH = tempDir;
		expect(checkBinAvailability("my-tool", envOverrideVar)).toEqual({
			available: true,
			path: binPath,
		});
	});
});
