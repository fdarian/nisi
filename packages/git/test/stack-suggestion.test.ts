import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	inferStackSuggestion,
	type OpenPullRequestNode,
} from "../src/github/gh/stack-suggestion.ts";

const pr = (
	number: number,
	head: string,
	base: string,
	overrides: Partial<OpenPullRequestNode> = {},
): OpenPullRequestNode => ({
	number,
	title: `PR ${number}`,
	isDraft: false,
	headRefName: head,
	baseRefName: base,
	isCrossRepository: false,
	stack: null,
	...overrides,
});

describe("inferStackSuggestion", () => {
	test("walks down and up from the middle of a linear chain", () => {
		const open = [pr(3, "c", "b"), pr(1, "a", "main"), pr(2, "b", "a")];
		const result = inferStackSuggestion(open, 2);
		expect(result?.baseRefName).toBe("main");
		expect(result?.size).toBe(3);
		expect(result?.position).toBe(2);
		expect(result?.entries.map((entry) => entry.number)).toEqual([1, 2, 3]);
		expect(result?.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
		expect(result?.entries.every((entry) => entry.state === "OPEN")).toBe(true);
	});

	test("reports the same chain from either end", () => {
		const open = [pr(1, "a", "main"), pr(2, "b", "a")];
		expect(inferStackSuggestion(open, 1)?.position).toBe(1);
		expect(inferStackSuggestion(open, 2)?.position).toBe(2);
	});

	test("stops walking up at a fork", () => {
		const open = [pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "a")];
		const fromBottom = inferStackSuggestion(open, 1);
		expect(fromBottom).toBeNull();
		const fromChild = inferStackSuggestion(open, 2);
		expect(fromChild?.entries.map((entry) => entry.number)).toEqual([1, 2]);
	});

	test("excludes cross-repository pull requests", () => {
		const open = [
			pr(1, "a", "main"),
			pr(2, "b", "a", { isCrossRepository: true }),
		];
		expect(inferStackSuggestion(open, 1)).toBeNull();
		expect(inferStackSuggestion(open, 2)).toBeNull();
	});

	test("excludes pull requests GitHub already stacked", () => {
		const open = [
			pr(1, "a", "main", { stack: { number: 9 } }),
			pr(2, "b", "a"),
		];
		expect(inferStackSuggestion(open, 1)).toBeNull();
		expect(inferStackSuggestion(open, 2)).toBeNull();
	});

	test("returns null for a lone pull request or an unknown number", () => {
		const open = [pr(1, "a", "main"), pr(2, "x", "main")];
		expect(inferStackSuggestion(open, 1)).toBeNull();
		expect(inferStackSuggestion(open, 99)).toBeNull();
	});

	test("terminates on a branch cycle", () => {
		const open = [pr(1, "a", "b"), pr(2, "b", "a")];
		const result = inferStackSuggestion(open, 1);
		expect(result?.size).toBe(2);
		expect(result?.entries.map((entry) => entry.number)).toEqual([2, 1]);
	});
});

const testDir = dirname(fileURLToPath(import.meta.url));

describe("GitHub.stackSuggestion", () => {
	test("infers a chain from the gh GraphQL response", async () => {
		const proc = Bun.spawn(
			["bun", "run", join(testDir, "fixtures/stack-suggestion-runner.ts"), "2"],
			{
				env: {
					...process.env,
					NISI_GH_BIN: join(testDir, "fixtures/gh-stack-suggestion-stub.sh"),
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
		const result = JSON.parse(stdout.trim());
		expect(result.ok).toBe(true);
		expect(result.value.size).toBe(2);
		expect(result.value.position).toBe(2);
		expect(result.value.baseRefName).toBe("main");
	});
});
