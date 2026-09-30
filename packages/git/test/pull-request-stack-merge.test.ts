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
	route = "stack",
	matchHeadCommit?: string,
): Promise<RunnerResult> => {
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			RUNNER,
			outcome,
			route,
			...(matchHeadCommit === undefined ? [] : [matchHeadCommit]),
		],
		{
			env: {
				...process.env,
				NISI_GH_BIN: GH_STUB,
				STACK_MERGE_OUTCOME: outcome,
				...(matchHeadCommit === undefined
					? {}
					: { MATCH_HEAD_COMMIT: matchHeadCommit }),
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
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
	test("pins regular scheduled merges with --match-head-commit", async () => {
		expect(await runAgainstGhStub("merged", "regular", "checked-head")).toEqual(
			{ ok: true },
		);
	});
	test("manual regular merges omit the head constraint", async () => {
		expect(await runAgainstGhStub("merged", "regular")).toEqual({ ok: true });
	});
	test("pins native stack merges with the async API sha field", async () => {
		expect(await runAgainstGhStub("merged", "stack", "checked-head")).toEqual({
			ok: true,
		});
	});
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
