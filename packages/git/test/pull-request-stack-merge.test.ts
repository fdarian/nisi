import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-stack-merge-stub.sh");
const RUNNER = join(testDir, "fixtures/merge-stack-runner.ts");

type RunnerResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly tag: string; readonly reason: string };

const runAgainstGhStub = async (
	outcome: "merged" | "failed",
): Promise<RunnerResult> => {
	const proc = Bun.spawn(["bun", "run", RUNNER, outcome], {
		env: {
			...process.env,
			NISI_GH_BIN: GH_STUB,
			STACK_MERGE_OUTCOME: outcome,
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

describe("mergeStackPullRequest", () => {
	test("polls pending until the stack merge is merged", async () => {
		expect(await runAgainstGhStub("merged")).toEqual({ ok: true });
	});

	test("surfaces GitHub's terminal failed message", async () => {
		expect(await runAgainstGhStub("failed")).toEqual({
			ok: false,
			tag: "GhStackMergeFailed",
			reason: "Stack layer #41 is not mergeable.",
		});
	});
});
