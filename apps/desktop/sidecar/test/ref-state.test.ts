import { expect, test } from "bun:test";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect } from "effect";
import {
	cleanupTestRepo,
	makeTestRepo,
} from "../../../../packages/git/test/fixtures.ts";
import { readRefState } from "../ref-state.ts";

test("ref fingerprints bypass per-worktree namespaces, pseudorefs and invalid refnames", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "base\n");
		await repo.commit("base");
		await repo.git(["remote", "add", "origin", repo.root]);
		await Effect.runPromise(
			Effect.gen(function* () {
				for (const ref of [
					"ORIG_HEAD",
					"abc123",
					"FETCH_HEAD",
					"MERGE_HEAD",
					"refs/worktree/private",
					"refs/bisect/good",
					"refs/rewritten/onto",
					"main-worktree/HEAD",
					"worktrees/other/HEAD",
					"refs/unknown/name",
					"refs/heads/.hidden",
					"refs/heads/a.lock",
					"refs/heads/a//b",
					"refs/heads/trailing.",
					"refs/heads/a../b",
				]) {
					expect(yield* readRefState(repo.root, ref)).toBeUndefined();
					expect(yield* readRefState(repo.root, "main", ref)).toBeUndefined();
				}
				for (const name of [
					"GIT_DIR",
					"GIT_COMMON_DIR",
					"GIT_WORK_TREE",
					"GIT_NAMESPACE",
					"GIT_OBJECT_DIRECTORY",
					"GIT_ALTERNATE_OBJECT_DIRECTORIES",
					"GIT_CONFIG",
					"GIT_CONFIG_COUNT",
					"GIT_CONFIG_PARAMETERS",
					"GIT_CONFIG_SYSTEM",
					"GIT_CONFIG_GLOBAL",
					"GIT_CONFIG_NOSYSTEM",
					"GIT_REPLACE_REF_BASE",
					"GIT_NO_REPLACE_OBJECTS",
					"GIT_SHALLOW_FILE",
					"GIT_GRAFT_FILE",
				]) {
					expect(
						yield* readRefState(repo.root, "main").pipe(
							Effect.provide(
								ConfigProvider.layer(
									ConfigProvider.fromUnknown({ [name]: "override" }),
								),
							),
						),
					).toBeUndefined();
				}
				expect(yield* readRefState(repo.root, "refs/heads/main")).toBeDefined();
			}).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("linked-worktree HEAD and shorthand candidates are read from the effective git directory", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "base\n");
		const first = await repo.commit("base");
		await repo.git(["remote", "add", "origin", repo.root]);
		await repo.write("file", "next\n");
		const second = await repo.commit("next");
		const worktree = join(repo.root, "linked");
		await repo.git(["worktree", "add", "--detach", worktree, first]);
		const marker = await Bun.file(join(worktree, ".git")).text();
		const gitDir = marker.slice("gitdir: ".length).trim();
		const read = () =>
			Effect.runPromise(
				readRefState(worktree, "main").pipe(Effect.provide(BunServices.layer)),
			);
		const before = await read();
		expect(before).toBeDefined();
		await Bun.write(join(gitDir, "HEAD"), `${second}\n`);
		expect(await read()).not.toBe(before);
		const beforeCandidate = await read();
		await Bun.write(join(gitDir, "main"), `${first}\n`);
		expect(await read()).not.toBe(beforeCandidate);
		await Bun.write(join(gitDir, "HEAD"), "ref: refs/worktree/private\n");
		expect(await read()).toBeUndefined();
		await Bun.write(join(gitDir, "HEAD"), "ref: refs/heads/alias\n");
		await Bun.write(
			join(repo.root, ".git/refs/heads/alias"),
			"ref: refs/heads/main\n",
		);
		expect(await read()).toBeUndefined();
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("qualified local bases include their selected remote branch; nested remotes bypass the cache", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "base\n");
		const first = await repo.commit("base");
		await repo.git(["remote", "add", "origin", repo.root]);
		await repo.git(["update-ref", "refs/remotes/origin/main", first]);
		const read = () =>
			Effect.runPromise(
				readRefState(repo.root, "refs/heads/main").pipe(
					Effect.provide(BunServices.layer),
				),
			);
		const before = await read();
		expect(before).toBeDefined();
		await repo.write("file", "next\n");
		const second = await repo.commit("next");
		await repo.git(["reset", "--hard", first]);
		await repo.git(["update-ref", "refs/remotes/origin/main", second]);
		expect(await read()).not.toBe(before);
		await repo.git(["remote", "add", "nested/remote", repo.root]);
		expect(await read()).toBeUndefined();
	} finally {
		await cleanupTestRepo(repo);
	}
});
