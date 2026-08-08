import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-ready-stub.sh");
const RUNNER = join(testDir, "fixtures/mark-pull-request-ready-runner.ts");

type RunnerResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly tag: string };

/**
 * Runs `markPullRequestReady` in a fresh `bun` process with `gh` pointed at
 * `fixtures/gh-ready-stub.sh` — see `search-pull-requests.test.ts` for why
 * this can't just call the function in-process.
 */
const runAgainstGhStub = async (number: number): Promise<RunnerResult> => {
	const proc = Bun.spawn(["bun", "run", RUNNER, "/tmp", String(number)], {
		env: { ...process.env, NISI_GH_BIN: GH_STUB },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`runner exited ${exitCode}: ${stderr}`);
	}
	return JSON.parse(stdout.trim());
};

describe("markPullRequestReady", () => {
	test("succeeds when gh pr ready exits 0", async () => {
		const result = await runAgainstGhStub(42);
		expect(result.ok).toBe(true);
	});

	test("fails with PullRequestNotFound when the number doesn't resolve", async () => {
		const result = await runAgainstGhStub(999);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.tag).toBe("PullRequestNotFound");
	});

	test("gh not authenticated (exit code 4) fails with GhNotAuthenticated", async () => {
		const result = await runAgainstGhStub(4004);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.tag).toBe("GhNotAuthenticated");
	});

	test("an unclassified gh failure falls back to GhPullRequestReadyFailed", async () => {
		const result = await runAgainstGhStub(500);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.tag).toBe("GhPullRequestReadyFailed");
	});
});
