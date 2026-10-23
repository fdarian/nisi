import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const NOW_ISO = "2026-10-23T12:00:00Z";
const CLOSED_CUTOFF = "2026-10-16";

/** Every `q=` string `gh` was called with, one per search issued. */
const searchedQueries = async (
	query: string,
	repos: readonly string[],
	state: "open" | "closed",
): Promise<ReadonlyArray<string>> => {
	const queryLog = join(
		mkdtempSync(join(tmpdir(), "nisi-search-")),
		"queries.log",
	);
	const result = await runAgainstGhStub(query, repos, state, queryLog);
	expect(result.ok).toBe(true);
	return readFileSync(queryLog, "utf8").trim().split("\n");
};

/**
 * Runs `searchPullRequests` in a fresh `bun` process with `gh` pointed at
 * `fixtures/gh-search-stub.sh` — see `search-pull-requests-runner.ts` for why
 * this can't just call the function in-process.
 */
const runAgainstGhStub = async (
	query: string,
	repos: readonly string[] = [],
	state: "open" | "closed" = "open",
	queryLog?: string,
): Promise<RunnerResult> => {
	const proc = Bun.spawn(
		["bun", "run", RUNNER, testDir, query, state, ...repos],
		{
			env: {
				...process.env,
				NISI_GH_BIN: GH_STUB,
				NISI_EXPECT_SEARCH_REPOS: repos.join(" "),
				NISI_NOW_ISO: NOW_ISO,
				...(queryLog === undefined ? {} : { NISI_GH_QUERY_LOG: queryLog }),
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

describe("searchPullRequests", () => {
	test("a single repository filter scopes an empty query", async () => {
		const result = await runAgainstGhStub("", ["acme/widgets"]);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.results.map((pr) => pr.number)).toEqual([50]);
	});
	for (const query of ["", "engine", "is:merged", "repo:acme/widgets engine"]) {
		test(`repository filters search without personal scope: ${JSON.stringify(query)}`, async () => {
			const result = await runAgainstGhStub(query, [
				"acme/widgets",
				"acme/tools",
			]);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.results.map((pr) => pr.number)).toEqual([50]);
		});
	}
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
				state: "OPEN",
				mergeable: "MERGEABLE",
				mergeStateStatus: "CLEAN",
				rollupState: null,
			},
		]);
	});

	test("qualifier passthrough with its own state qualifier: --state open is suppressed, not ANDed on top", async () => {
		const result = await runAgainstGhStub("repo:acme/widgets is:merged");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.results.map((r) => r.number)).toEqual([50]);
	});

	test("a PR by a deleted user (null author) decodes with author ghost", async () => {
		const result = await runAgainstGhStub("TRIGGER_GHOST");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.results.map((r) => [r.number, r.author])).toEqual([
			[7, "ghost"],
		]);
	});

	test("gh not authenticated (exit code 4) fails with GhNotAuthenticated", async () => {
		const result = await runAgainstGhStub("TRIGGER_AUTH_FAIL");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.tag).toBe("GhNotAuthenticated");
	});

	test("bad credentials fail with GhNotAuthenticated", async () => {
		const result = await runAgainstGhStub("TRIGGER_BAD_CREDENTIALS");
		expect(result).toEqual({ ok: false, tag: "GhNotAuthenticated" });
	});

	test("malformed GraphQL output fails with GhOutputDecodeError", async () => {
		const result = await runAgainstGhStub("TRIGGER_DECODE");
		expect(result).toEqual({ ok: false, tag: "GhOutputDecodeError" });
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

	test("closed mode on a blank query: author:@me, is:closed and a closed:>= cutoff 7 days back, no is:open", async () => {
		const [q] = await searchedQueries("", [], "closed");
		expect(q).toBe(
			`is:pr author:@me is:closed closed:>=${CLOSED_CUTOFF} sort:updated-desc`,
		);
	});

	test("closed mode with a repository chip keeps the repo scope", async () => {
		const [q] = await searchedQueries("", ["acme/widgets"], "closed");
		expect(q).toBe(
			`is:pr repo:acme/widgets is:closed closed:>=${CLOSED_CUTOFF} sort:updated-desc`,
		);
	});

	test("closed mode with a typed explicit state qualifier adds neither is:closed nor closed:>=", async () => {
		const [q] = await searchedQueries(
			"repo:acme/widgets is:merged",
			[],
			"closed",
		);
		expect(q).toBe("is:pr repo:acme/widgets is:merged sort:updated-desc");
	});

	test("closed mode unions author and review-requested for a typed query", async () => {
		const queries = await searchedQueries("engine", [], "closed");
		expect([...queries].sort()).toEqual([
			`is:pr engine author:@me is:closed closed:>=${CLOSED_CUTOFF} sort:updated-desc`,
			`is:pr engine review-requested:@me is:closed closed:>=${CLOSED_CUTOFF} sort:updated-desc`,
		]);
	});

	test("open mode adds is:open", async () => {
		const [q] = await searchedQueries("", [], "open");
		expect(q).toBe("is:pr author:@me is:open sort:updated-desc");
	});

	for (const typed of [
		"repo:acme/widgets closed:>=2026-10-01",
		"repo:acme/widgets -merged:<2026-10-01",
	]) {
		test(`a typed date qualifier in open mode no longer gets is:open: ${typed}`, async () => {
			const [q] = await searchedQueries(typed, [], "open");
			expect(q).toBe(`is:pr ${typed} sort:updated-desc`);
		});
	}
});
