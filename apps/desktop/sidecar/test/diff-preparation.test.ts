import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	cleanupTestRepo,
	makeTestRepo,
} from "../../../../packages/git/test/fixtures.ts";
import { makeDiffPreparation } from "../diff-preparation.ts";
import { readRefState } from "../ref-state.ts";

test("metadata and contents share one committed preparation, but changed refs and worktree edits do not", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "base\n");
		await repo.commit("base");
		await repo.git(["remote", "add", "origin", repo.root]);
		await repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
		await repo.git(["checkout", "-b", "feature"]);
		await repo.write("file", "head\n");
		await repo.commit("head");
		await Effect.runPromise(
			Effect.gen(function* () {
				expect(yield* readRefState(repo.root, "main")).toBeDefined();
				const preparation = yield* makeDiffPreparation();
				const first = yield* preparation.read(repo.root, "main", {
					includeUncommitted: false,
				});
				expect(
					yield* preparation.read(repo.root, "main", {
						includeUncommitted: false,
					}),
				).toBe(first);
				yield* Effect.promise(async () => {
					await repo.write("file", "next\n");
					await repo.commit("next");
				});
				expect(
					yield* preparation.read(repo.root, "main", {
						includeUncommitted: false,
					}),
				).not.toBe(first);
				const beforeBase = yield* preparation.read(repo.root, "main", {
					includeUncommitted: false,
				});
				yield* Effect.promise(() =>
					repo.git(["update-ref", "refs/remotes/origin/main", "HEAD"]),
				);
				const afterBase = yield* preparation.read(repo.root, "main", {
					includeUncommitted: false,
				});
				expect(afterBase).not.toBe(beforeBase);
				expect(afterBase.entries).toHaveLength(0);
				yield* Effect.promise(() =>
					repo.git(["pack-refs", "--all", "--prune"]),
				);
				const packed = yield* preparation.read(repo.root, "main", {
					includeUncommitted: false,
				});
				expect(packed.mergeBase).toBe(afterBase.mergeBase);
				expect(yield* readRefState(repo.root, "origin/main")).toBeDefined();
				const explicitRemote = yield* preparation.read(
					repo.root,
					"origin/main",
					{ includeUncommitted: false },
				);
				expect(explicitRemote.entries).toHaveLength(0);
				const dirty = yield* preparation.read(repo.root, "main", {
					includeUncommitted: true,
				});
				expect(
					yield* preparation.read(repo.root, "main", {
						includeUncommitted: true,
					}),
				).not.toBe(dirty);
			}).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});
