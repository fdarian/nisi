import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-stack-stub.sh");
const RUNNER = join(testDir, "fixtures/fetch-pull-request-stack-runner.ts");

type RunnerResult =
	| {
			readonly ok: true;
			readonly value: {
				readonly number: number;
				readonly size: number;
				readonly baseRefName: string;
				readonly position: number;
				readonly entries: readonly {
					readonly position: number;
					readonly number: number;
					readonly title: string;
					readonly headRefName: string;
					readonly baseRefName: string;
					readonly state: string;
					readonly isDraft: boolean;
				}[];
			} | null;
	  }
	| { readonly ok: false; readonly tag: string };

const runAgainstGhStub = async (number: number): Promise<RunnerResult> => {
	const proc = Bun.spawn(["bun", "run", RUNNER, String(number)], {
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

describe("fetchPullRequestStack", () => {
	test("parses a stack and orders entries by position", async () => {
		const result = await runAgainstGhStub(42);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				number: 7,
				size: 2,
				baseRefName: "main",
				position: 2,
				entries: [
					{
						position: 1,
						number: 41,
						title: "First layer",
						headRefName: "stack/one",
						baseRefName: "main",
						state: "MERGED",
						isDraft: false,
					},
					{
						position: 2,
						number: 42,
						title: "Second layer",
						headRefName: "stack/two",
						baseRefName: "stack/one",
						state: "OPEN",
						isDraft: false,
					},
				],
			});
		}
	});

	test("returns null for a pull request that is not stacked", async () => {
		const result = await runAgainstGhStub(43);
		expect(result).toEqual({ ok: true, value: null });
	});
});
