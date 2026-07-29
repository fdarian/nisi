import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { resolveReviewTarget } from "../src/pull-request.ts";
import { resolveLocalDefaultBranch } from "../src/repo.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const runExit = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(
		Effect.exit(effect.pipe(Effect.provide(BunServices.layer))),
	);

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
