import { describe, expect, test } from "bun:test";
import type { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { GitHub } from "../src/github/github.ts";
import { resolveReviewTarget } from "../src/pull-request.ts";
import { resolveLocalDefaultBranch } from "../src/repo.ts";
import { GitHubTestLayer } from "./fixtures/github-layer.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		BunServices.BunServices | import("../src/github/github.ts").GitHub
	>,
) => Effect.runPromise(effect.pipe(Effect.provide(GitHubTestLayer)));

const runExit = <A, E>(
	effect: Effect.Effect<
		A,
		E,
		BunServices.BunServices | import("../src/github/github.ts").GitHub
	>,
) =>
	Effect.runPromise(Effect.exit(effect.pipe(Effect.provide(GitHubTestLayer))));

describe("resolveLocalDefaultBranch", () => {
	test("picks the conventional branch that actually exists", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);

			expect(await run(resolveLocalDefaultBranch(repo.root))).toBe("main");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("prefers what origin/HEAD points at over a conventional name", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "trunk"]);
			// A stand-in for what `git clone` records: a remote-tracking ref plus
			// the symbolic `origin/HEAD` naming it.
			await repo.git(["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
			await repo.git([
				"symbolic-ref",
				"refs/remotes/origin/HEAD",
				"refs/remotes/origin/trunk",
			]);

			expect(await run(resolveLocalDefaultBranch(repo.root))).toBe(
				"origin/trunk",
			);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("fails with NoDefaultBranch when nothing names a reviewable branch", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git(["branch", "-m", "main", "wip"]);
			await repo.git(["config", "init.defaultBranch", "nonexistent"]);

			const exit = await runExit(resolveLocalDefaultBranch(repo.root));
			expect(exit._tag).toBe("Failure");
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});

describe("resolveReviewTarget", () => {
	test("uses the GitHub service for a repo with a remote", async () => {
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
			const target = await run(
				Effect.gen(function* () {
					const adapter = yield* GitHub;
					return yield* resolveReviewTarget(repo.root).pipe(
						Effect.provideService(GitHub, {
							...adapter,
							repository: () =>
								Effect.succeed({
									owner: "acme",
									repo: "widgets",
									defaultBranch: "main",
								}),
							pullRequest: () =>
								Effect.succeed({
									number: 42,
									title: "Feature",
									baseRef: "main",
									headRef: "feature",
								}),
						}),
					);
				}),
			);
			expect(target.github).toEqual({
				owner: "acme",
				repo: "widgets",
				pr: {
					number: 42,
					title: "Feature",
					baseRef: "main",
					headRef: "feature",
				},
			});
		} finally {
			await cleanupTestRepo(repo);
		}
	});
	// No remote means no GitHub, decided from the repo alone — so this never
	// shells out to `gh` and stays offline-safe in CI.
	test("degrades to a local-only target for a repo with no remote", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.git(["checkout", "-q", "-b", "feature"]);

			const target = await run(resolveReviewTarget(repo.root));
			expect(target.github).toBeNull();
			expect(target.defaultBranch).toBe("main");
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
