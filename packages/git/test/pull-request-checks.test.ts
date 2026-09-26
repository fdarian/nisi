import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import {
	decodeAwaitingWorkflowRuns,
	toPullRequestCheck,
} from "../src/github/gh/checks.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const runAgainstGhStub = async (operation: string) => {
	const proc = Bun.spawn(
		["bun", "run", join(testDir, "fixtures/workflow-runner.ts"), operation],
		{
			env: {
				...process.env,
				NISI_GH_BIN: join(testDir, "fixtures/gh-workflow-stub.sh"),
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
	if (exitCode !== 0) throw new Error(`runner exited ${exitCode}: ${stderr}`);
	return JSON.parse(stdout.trim()) as {
		ok: boolean;
		tag?: string;
		value?: unknown;
	};
};

describe("awaiting approval workflow runs", () => {
	test("maps REST runs to actionable checks without changing CheckRun ACTION_REQUIRED", async () => {
		const checks = await Effect.runPromise(
			decodeAwaitingWorkflowRuns(
				"gh api",
				JSON.stringify({
					workflow_runs: [
						{
							id: 101,
							name: "CI",
							html_url: "https://github.com/acme/widgets/actions/runs/101",
						},
						{
							id: 102,
							name: "Tests",
							html_url: "https://github.com/acme/widgets/actions/runs/102",
						},
					],
				}),
			),
		);
		expect(checks).toEqual([
			{
				name: "CI",
				workflowName: "CI",
				status: "awaiting_approval",
				detailsUrl: "https://github.com/acme/widgets/actions/runs/101",
				workflowRunId: 101,
			},
			{
				name: "Tests",
				workflowName: "Tests",
				status: "awaiting_approval",
				detailsUrl: "https://github.com/acme/widgets/actions/runs/102",
				workflowRunId: 102,
			},
		]);
		expect(
			toPullRequestCheck({
				__typename: "CheckRun",
				name: "test",
				status: "COMPLETED",
				conclusion: "ACTION_REQUIRED",
				startedAt: "0001-01-01T00:00:00Z",
				completedAt: "0001-01-01T00:00:00Z",
				detailsUrl: "",
				workflowName: "CI",
			}).status,
		).toBe("failing");
	});

	test("rejects a malformed REST response instead of silently hiding runs", async () => {
		const result = await Effect.runPromiseExit(
			decodeAwaitingWorkflowRuns("gh api", '{"workflow_runs":[{"id":"bad"}]}'),
		);
		expect(result._tag).toBe("Failure");
	});
});

describe("workflow gh calls", () => {
	test("filters concurrently fetched action_required runs by PR head SHA", async () => {
		expect((await runAgainstGhStub("fetch")).value).toEqual([
			{
				name: "CI",
				workflowName: "CI",
				status: "awaiting_approval",
				detailsUrl: "https://github.com/acme/widgets/actions/runs/101",
				workflowRunId: 101,
			},
		]);
	});
	test("uses a SHA-scoped read when repo-wide runs are truncated", async () => {
		expect((await runAgainstGhStub("fetch-truncated")).value).toEqual(
			(await runAgainstGhStub("fetch")).value,
		);
	});
	test("approves each run", async () => {
		expect((await runAgainstGhStub("approve")).ok).toBe(true);
	});
	test("classifies a 403 as a permission error", async () => {
		expect((await runAgainstGhStub("forbidden")).tag).toBe(
			"WorkflowApprovalForbidden",
		);
	});
});
