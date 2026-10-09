import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-pr-states-stub.sh");
const RUNNER = join(testDir, "fixtures/pull-request-states-runner.ts");

type RunnerResult =
	| {
			readonly ok: true;
			readonly states: ReadonlyArray<{ number: number; state: string }>;
	  }
	| { readonly ok: false; readonly tag: string };

/** See `search-pull-requests.test.ts` for why this runs in a fresh `bun` process. */
const runAgainstGhStub = async (repo: string): Promise<RunnerResult> => {
	const proc = Bun.spawn(["bun", "run", RUNNER, "acme", repo], {
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

describe("pullRequestStates", () => {
	test("returns every listed PR with its gh state", async () => {
		expect(await runAgainstGhStub("widgets")).toEqual({
			ok: true,
			states: [
				{ number: 9, state: "OPEN" },
				{ number: 8, state: "MERGED" },
				{ number: 7, state: "CLOSED" },
			],
		});
	});

	for (const [repo, tag] of [
		["auth", "GhNotAuthenticated"],
		["limited", "GhRateLimited"],
		["offline", "GitHubUnreachable"],
		["garbled", "GhOutputDecodeError"],
	] as const) {
		test(`${repo} fails with ${tag}`, async () => {
			expect(await runAgainstGhStub(repo)).toEqual({ ok: false, tag });
		});
	}
});
