import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-stack-create-stub.sh");
const RUNNER = join(testDir, "fixtures/create-stack-runner.ts");

type RunnerResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly tag: string; readonly reason: string };

const runAgainstGhStub = async (outcome: string): Promise<RunnerResult> => {
	const proc = Bun.spawn(["bun", "run", RUNNER], {
		env: {
			...process.env,
			NISI_GH_BIN: GH_STUB,
			STACK_CREATE_OUTCOME: outcome,
		},
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

describe("createStack", () => {
	test("POSTs the stacks endpoint with one pull_requests[] field per PR, bottom to top", async () => {
		expect(await runAgainstGhStub("created")).toEqual({ ok: true });
	});

	test("maps an unauthenticated gh to GhNotAuthenticated", async () => {
		const result = await runAgainstGhStub("unauthenticated");
		expect(result).toMatchObject({ ok: false, tag: "GhNotAuthenticated" });
	});

	test("maps a rate limit to GhRateLimited", async () => {
		const result = await runAgainstGhStub("rate-limited");
		expect(result).toMatchObject({ ok: false, tag: "GhRateLimited" });
	});

	test("carries gh's stderr in GhStackCreateFailed for any other failure", async () => {
		expect(await runAgainstGhStub("not-enabled")).toEqual({
			ok: false,
			tag: "GhStackCreateFailed",
			reason: "gh: Not Found (HTTP 404)",
		});
	});
});
