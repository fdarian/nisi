import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PullRequestSearchResult } from "../src/pull-request.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-search-stub.sh");
const RUNNER = join(testDir, "fixtures/search-pull-requests-runner.ts");

type RunnerResult =
	| {
			readonly ok: true;
			readonly results: ReadonlyArray<PullRequestSearchResult>;
	  }
	| { readonly ok: false; readonly tag: string };

/**
 * Runs `searchPullRequests` in a fresh `bun` process with `gh` pointed at
 * `fixtures/gh-search-stub.sh` — see `search-pull-requests-runner.ts` for why
 * this can't just call the function in-process.
 */
const runAgainstGhStub = async (query: string): Promise<RunnerResult> => {
	const proc = Bun.spawn(["bun", "run", RUNNER, testDir, query], {
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

describe("searchPullRequests", () => {
	test("empty query: author-only, not unioned with review-requested", async () => {
		const result = await runAgainstGhStub("");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The stub's `--author` branch returns #10 and #30 (isDraft: true) —
		// if this were wrongly unioned with review-requested, #30 would come
		// back as the review-requested branch's isDraft:false variant instead.
		expect(result.results.map((r) => r.number)).toEqual([30, 10]);
		expect(result.results.find((r) => r.number === 30)?.isDraft).toBe(true);
	});

	test("typed query with no qualifier: unions author and review-requested, deduped and sorted by updatedAt desc", async () => {
		const result = await runAgainstGhStub("engine");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// #30 appears in both the author and review-requested fixtures with
		// different updatedAt/isDraft — deduped to one entry (the
		// review-requested version, later in the merge order) rather than
		// showing up twice.
		expect(result.results.map((r) => r.number)).toEqual([30, 10, 20]);
		expect(result.results.find((r) => r.number === 30)?.isDraft).toBe(false);
	});

	test("qualifier passthrough (repo:): no author/review-requested scoping, still defaults to --state open", async () => {
		const result = await runAgainstGhStub("repo:acme/widgets auth");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.results).toEqual([
			{
				owner: "acme",
				repo: "widgets",
				number: 50,
				title: "Passthrough result",
				author: "someoneelse",
				updatedAt: "2026-01-01T00:00:00Z",
				url: "https://github.com/acme/widgets/pull/50",
				isDraft: false,
			},
		]);
	});

	test("qualifier passthrough with its own state qualifier: --state open is suppressed, not ANDed on top", async () => {
		const result = await runAgainstGhStub("repo:acme/widgets is:merged");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.results.map((r) => r.number)).toEqual([50]);
	});

	test("gh not authenticated (exit code 4) fails with GhNotAuthenticated", async () => {
		const result = await runAgainstGhStub("TRIGGER_AUTH_FAIL");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.tag).toBe("GhNotAuthenticated");
	});

	test("rate-limited response fails with GhRateLimited", async () => {
		const result = await runAgainstGhStub("TRIGGER_RATE_LIMIT");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.tag).toBe("GhRateLimited");
	});

	test("an unclassified gh failure falls back to GitHubSearchUnreachable", async () => {
		const result = await runAgainstGhStub("TRIGGER_UNREACHABLE");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.tag).toBe("GitHubSearchUnreachable");
	});
});
