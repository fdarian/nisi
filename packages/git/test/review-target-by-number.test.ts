import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { resolveReviewTargetForPullRequest } from "../src/pull-request.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const GH_STUB = join(testDir, "fixtures/gh-stub.sh");
const RUNNER = join(testDir, "fixtures/resolve-review-target-runner.ts");

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

type RunnerResult =
	| {
			readonly ok: true;
			readonly defaultBranch: string;
			readonly owner: string | null;
			readonly prNumber: number | null;
			readonly prTitle: string | null;
	  }
	| { readonly ok: false; readonly tag: string };

/**
 * Runs `pull-request.ts`'s resolvers in a fresh `bun` process with `gh`
 * pointed at `fixtures/gh-stub.sh` — see `resolve-review-target-runner.ts`
 * for why this can't just call the functions in-process.
 */
const runAgainstGhStub = async (
	mode: "branch" | "byNumber",
	repoRoot: string,
	number?: number,
): Promise<RunnerResult> => {
	const proc = Bun.spawn(
		[
			"bun",
			"run",
			RUNNER,
			mode,
			repoRoot,
			number === undefined ? "" : String(number),
		],
		{
			env: { ...process.env, NISI_GH_BIN: GH_STUB },
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

describe("resolveReviewTargetForPullRequest", () => {
	// No remote means no GitHub, decided from the repo alone — shared with
	// `resolveReviewTarget`'s own such test, so this never shells out to `gh`
	// and stays offline-safe in CI.
	test("degrades to a local-only target for a repo with no remote", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");

			const target = await run(
				resolveReviewTargetForPullRequest(repo.root, 42),
			);
			expect(target.github).toBeNull();
			expect(target.defaultBranch).toBe("main");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("resolves the PR named by number, not the checked-out branch's PR", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git([
				"remote",
				"add",
				"origin",
				"https://github.com/acme/widgets.git",
			]);
			// The worktree bug this resolver exists to fix: the checked-out
			// branch is nisi's own local branch, never the PR author's — a
			// branch-based `gh pr view` could never resolve it.
			await repo.git(["checkout", "-q", "-b", "nisi/pr-42/feature"]);

			const result = await runAgainstGhStub("byNumber", repo.root, 42);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.owner).toBe("acme");
				expect(result.prNumber).toBe(42);
				expect(result.prTitle).toBe("Add widgets");
				expect(result.defaultBranch).toBe("main");
			}
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("fails with PullRequestNotFound instead of degrading when the number doesn't resolve", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git([
				"remote",
				"add",
				"origin",
				"https://github.com/acme/widgets.git",
			]);
			await repo.git(["checkout", "-q", "-b", "nisi/pr-999/feature"]);

			const result = await runAgainstGhStub("byNumber", repo.root, 999);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.tag).toBe("PullRequestNotFound");
			}
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("the branch-based resolver keeps resolving from the checked-out branch, unaffected by this change", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git([
				"remote",
				"add",
				"origin",
				"https://github.com/acme/widgets.git",
			]);

			const result = await runAgainstGhStub("branch", repo.root);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.prNumber).toBe(7);
			}
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
