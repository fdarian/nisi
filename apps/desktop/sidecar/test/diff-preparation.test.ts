import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	cleanupTestRepo,
	makeTestRepo,
} from "../../../../packages/git/test/fixtures.ts";
import { makeDiffPreparation } from "../diff-preparation.ts";

test("metadata and contents share one committed preparation, but changed refs and worktree edits do not", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "base\n");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.write("file", "head\n");
		await repo.commit("head");
		await Effect.runPromise(
			Effect.gen(function* () {
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
