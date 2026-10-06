import { expect, test } from "bun:test";
import { chmod, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
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
				const localBase = yield* preparation.localBase(repo.root, "main");
				expect(yield* preparation.localBase(repo.root, "main")).toBe(localBase);
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
				const changedBase = yield* preparation.localBase(repo.root, "main");
				expect(changedBase).not.toBe(localBase);
				expect(changedBase.commit).not.toBe(localBase.commit);
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
				).toBe(dirty);
				yield* Effect.promise(() => repo.write("file", "edit\n"));
				const edited = yield* preparation.read(repo.root, "main", {
					includeUncommitted: true,
				});
				expect(edited).not.toBe(dirty);
				expect(edited.patches.get("file")).toContain("+edit");
				yield* Effect.promise(() => repo.write("file", "EDIT\n"));
				const sameSize = yield* preparation.read(repo.root, "main", {
					includeUncommitted: true,
				});
				expect(sameSize).not.toBe(edited);
				yield* Effect.promise(() => chmod(join(repo.root, "file"), 0o755));
				const executable = yield* preparation.read(repo.root, "main", {
					includeUncommitted: true,
				});
				expect(executable).not.toBe(sameSize);
				yield* Effect.promise(() => symlink("file", join(repo.root, "link")));
				const link = yield* preparation.read(repo.root, "main", {
					includeUncommitted: true,
				});
				yield* Effect.promise(async () => {
					await rm(join(repo.root, "link"));
					await symlink("other", join(repo.root, "link"));
				});
				expect(
					yield* preparation.read(repo.root, "main", {
						includeUncommitted: true,
					}),
				).not.toBe(link);
				yield* Effect.promise(() => repo.write("new-dir/untracked", "one\n"));
				const untracked = yield* preparation.read(repo.root, "main", {
					includeUncommitted: true,
				});
				expect(untracked.untrackedPaths).toContain("new-dir/untracked");
				expect(
					yield* preparation.read(repo.root, "main", {
						includeUncommitted: true,
					}),
				).toBe(untracked);
				yield* Effect.promise(() => repo.write("new-dir/untracked", "two\n"));
				expect(
					yield* preparation.read(repo.root, "main", {
						includeUncommitted: true,
					}),
				).not.toBe(untracked);
			}).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("base resolution stays on Git when the ref fingerprint does not support the repository", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "base\n");
		await repo.commit("base");
		await Effect.runPromise(
			Effect.gen(function* () {
				const preparation = yield* makeDiffPreparation();
				expect(yield* readRefState(repo.root, "main")).toBeUndefined();
				const first = yield* preparation.localBase(repo.root, "main");
				expect(yield* preparation.localBase(repo.root, "main")).not.toBe(first);
				yield* Effect.promise(async () => {
					await repo.write("file", "next\n");
					await repo.commit("next");
				});
				expect(
					(yield* preparation.localBase(repo.root, "main")).commit,
				).not.toBe(first.commit);
			}).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});
