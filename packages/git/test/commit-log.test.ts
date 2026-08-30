import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { fetchBranchCommits } from "../src/commit-log.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("fetchBranchCommits", () => {
	test("returns commits oldest-first with a null body when the commit has none", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.txt", "1\n");
			const base = await repo.commit("base");

			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.write("a.txt", "2\n");
			await repo.commit("first change");
			await repo.write("a.txt", "3\n");
			await repo.commit(
				"second change\n\nWith a multi-line body.\nSecond line.",
			);

			const commits = await run(fetchBranchCommits(repo.root, base, "feature"));

			expect(commits.map((c) => c.headline)).toEqual([
				"first change",
				"second change",
			]);
			expect(commits[0]?.body).toBeNull();
			expect(commits[1]?.body).toBe("With a multi-line body.\nSecond line.");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("every commit has a null authorLogin/url/checks — no GitHub identity or CI off local git log", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.txt", "1\n");
			const base = await repo.commit("base");
			await repo.write("a.txt", "2\n");
			await repo.commit("change");

			const commits = await run(fetchBranchCommits(repo.root, base, "HEAD"));

			expect(commits).toHaveLength(1);
			expect(commits[0]?.authorLogin).toBeNull();
			expect(commits[0]?.url).toBeNull();
			expect(commits[0]?.checks).toBeNull();
			expect(commits[0]?.authorName).toBe("Test");
			expect(commits[0]?.sha).toHaveLength(40);
			expect(commits[0]?.sha.startsWith(commits[0]?.shortSha ?? "")).toBe(true);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns an empty list when headRef has no commits past baseRef", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.txt", "1\n");
			const base = await repo.commit("base");

			const commits = await run(fetchBranchCommits(repo.root, base, "HEAD"));

			expect(commits).toEqual([]);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
