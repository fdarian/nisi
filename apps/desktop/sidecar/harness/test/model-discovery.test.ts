import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber, Result } from "effect";

/**
 * `discoverClaudeCodeModels` reaches `@anthropic-ai/claude-agent-sdk`'s
 * `query()` through a *dynamic* `await import(...)` inside its own function
 * body (see `model-discovery.ts`), not a static top-level import — unlike
 * `chat/sessions.test.ts`'s `@ai-sdk/harness/agent` mock (which has to land
 * before `sessions.ts` itself is first evaluated), this only has to land
 * before the function actually *runs*, so a plain top-level import of
 * `model-discovery.ts` below is enough; no `await import("../model-discovery.ts")`
 * dance needed. Same reason to mock at the module boundary as that file:
 * a real `query()` call spawns a real `claude` subprocess and talks to a
 * real account, neither of which belongs in a unit test — and this file's
 * whole point is asserting what happens to the *fake* subprocess's
 * `AbortController`, which no real CLI would let us observe from outside.
 */
let lastAbortController: AbortController | undefined;
let supportedModelsBehavior: "resolve" | "hang" = "resolve";

const fakeSession = {
	[Symbol.asyncIterator]: () => ({
		// Mirrors a real idle session's drain loop: never yields, same as the
		// real `idlePrompt()` this discovery call sends.
		next: () => new Promise<never>(() => {}),
	}),
	supportedModels: async () => {
		if (supportedModelsBehavior === "hang") {
			await new Promise<never>(() => {});
		}
		return [{ value: "m", displayName: "M" }];
	},
};

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
	query: (opts: { options: { abortController?: AbortController } }) => {
		lastAbortController = opts.options.abortController;
		return fakeSession;
	},
}));

const { discoverClaudeCodeModels, runCli } = await import(
	"../model-discovery.ts"
);

const isAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

const waitUntil = async (
	predicate: () => boolean,
	timeoutMs = 2000,
): Promise<void> => {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("waitUntil timed out");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

describe("runCli — process teardown", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "run-cli-teardown-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Announces its own pid to a file (not stdout — a pipe only flushes to
	 * `new Response(proc.stdout).text()` once the process exits, which
	 * defeats the point of observing the pid *before* teardown) and then
	 * sleeps far longer than any test here waits. `exec` replaces the shell's
	 * own process image with `sleep` rather than forking a child for it — one
	 * process, whose pid is exactly the `$$` captured a line earlier, so
	 * killing that one pid can't leave an orphaned grandchild for this test
	 * to misreport as "still running" or silently miss.
	 */
	const makeSleepyScript = (pidFile: string): string => {
		const scriptPath = join(tempDir, "sleepy.sh");
		writeFileSync(
			scriptPath,
			`#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`,
		);
		chmodSync(scriptPath, 0o755);
		return scriptPath;
	};

	const readPid = async (pidFile: string): Promise<number> => {
		await waitUntil(() => existsSync(pidFile));
		return Number(readFileSync(pidFile, "utf-8").trim());
	};

	test("kills the spawned process when the Effect is interrupted", async () => {
		const pidFile = join(tempDir, "pid");
		const scriptPath = makeSleepyScript(pidFile);

		const fiber = Effect.runFork(runCli(scriptPath, [], "codex", "cold-miss"));

		const pid = await readPid(pidFile);
		expect(isAlive(pid)).toBe(true);

		await Effect.runPromise(Fiber.interrupt(fiber));

		await waitUntil(() => !isAlive(pid));
		expect(isAlive(pid)).toBe(false);
	});

	test("kills the spawned process when the surrounding effect times out", async () => {
		const pidFile = join(tempDir, "pid");
		const scriptPath = makeSleepyScript(pidFile);

		// A short-ish outer timeout stands in for the real `DISCOVERY_TIMEOUT`
		// (15s, far too slow for a test) -- `Effect.timeout` interrupts the
		// fiber through the exact same mechanism an explicit `Fiber.interrupt`
		// does, so this exercises the identical teardown path
		// `DISCOVERY_TIMEOUT` relies on in production, just on a shorter
		// clock. 1 second, not a few hundred ms: a cold `/bin/sh` spawn under
		// a loaded sandbox can occasionally take longer than a real user
		// would ever wait to write a one-line pidfile, and this test needs
		// that write to land *before* the timeout fires to prove anything --
		// still two orders of magnitude faster than `DISCOVERY_TIMEOUT`.
		const outcome = await Effect.runPromise(
			Effect.result(
				runCli(scriptPath, [], "codex", "cold-miss").pipe(
					Effect.timeout("1 second"),
				),
			),
		);
		expect(Result.isFailure(outcome)).toBe(true);

		const pid = await readPid(pidFile);
		await waitUntil(() => !isAlive(pid));
		expect(isAlive(pid)).toBe(false);
	});

	test("a process that exits on its own is not affected by the teardown path", async () => {
		const scriptPath = join(tempDir, "quick.sh");
		writeFileSync(scriptPath, "#!/bin/sh\necho hello\n");
		chmodSync(scriptPath, 0o755);

		const stdout = await Effect.runPromise(
			runCli(scriptPath, [], "codex", "cold-miss"),
		);
		expect(stdout.trim()).toBe("hello");
	});
});

describe("discoverClaudeCodeModels — abortController teardown", () => {
	beforeEach(() => {
		lastAbortController = undefined;
		supportedModelsBehavior = "resolve";
	});

	test("aborts the controller passed into query()'s options once supportedModels() resolves", async () => {
		const models = await Effect.runPromise(
			discoverClaudeCodeModels("cold-miss"),
		);
		expect(models).toEqual([{ id: "m", label: "M" }]);
		expect(lastAbortController).toBeDefined();
		expect(lastAbortController?.signal.aborted).toBe(true);
	});

	test("aborts the controller when the surrounding effect times out", async () => {
		supportedModelsBehavior = "hang";

		const outcome = await Effect.runPromise(
			Effect.result(
				discoverClaudeCodeModels("cold-miss").pipe(
					Effect.timeout("100 millis"),
				),
			),
		);
		expect(Result.isFailure(outcome)).toBe(true);
		expect(lastAbortController).toBeDefined();
		expect(lastAbortController?.signal.aborted).toBe(true);
	});

	test("aborts the controller when the fiber is interrupted directly", async () => {
		supportedModelsBehavior = "hang";

		const fiber = Effect.runFork(discoverClaudeCodeModels("cold-miss"));
		await waitUntil(() => lastAbortController !== undefined);
		expect(lastAbortController?.signal.aborted).toBe(false);

		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(lastAbortController?.signal.aborted).toBe(true);
	});
});
