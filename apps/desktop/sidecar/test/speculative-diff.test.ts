import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect } from "effect";
import {
	cleanupTestRepo,
	makeTestRepo,
} from "../../../../packages/git/test/fixtures.ts";
import { makeSpeculativeDiff } from "../speculative-diff.ts";
import { makeDiffPreparation } from "../diff-preparation.ts";

test("speculation is invisible until confirmed; wrong base, moved refs, modes and forced requests miss", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file.ts", "base\n");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.write("file.ts", "head\n");
		await repo.commit("head");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cache = yield* makeSpeculativeDiff();
					const pending = yield* cache.start(repo.root, false);
					yield* Deferred.await(pending);
					expect(
						yield* cache.files(repo.root, "main", undefined, false),
					).toBeUndefined();
					yield* cache.confirm(pending, repo.root, "feature");
					expect(
						yield* cache.files(repo.root, "main", undefined, false),
					).toBeUndefined();
					yield* cache.confirm(pending, repo.root, "main");
					expect(
						(yield* cache.files(repo.root, "main", undefined, false))?.map(
							(file) => file.path,
						),
					).toEqual(["file.ts"]);
					expect(
						(yield* cache.contents(repo.root, "main", undefined, false, [
							{ path: "file.ts" },
						]))?.get("file.ts")?.newContent,
					).toBe("head\n");
					expect(
						yield* cache.contents(repo.root, "main", undefined, false, [
							{ path: "file.ts", force: true },
						]),
					).toBeUndefined();
					expect(
						yield* cache.contents(repo.root, "main", undefined, false, [
							{ path: "missing" },
						]),
					).toBeUndefined();
					expect(
						yield* cache.files(repo.root, "main", undefined, true),
					).toBeUndefined();
					expect(
						yield* cache.files(repo.root, "main", "main", false),
					).toBeUndefined();
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("dirty worktree changes invalidate confirmed speculative content", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file.ts", "base\n");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.write("file.ts", "dirty\n");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const cache = yield* makeSpeculativeDiff();
					const pending = yield* cache.start(repo.root, true);
					yield* Deferred.await(pending);
					yield* cache.confirm(pending, repo.root, "main");
					expect(
						(yield* cache.contents(repo.root, "main", undefined, true, [
							{ path: "file.ts" },
						]))?.get("file.ts")?.newContent,
					).toBe("dirty\n");
					yield* Effect.promise(() => repo.write("file.ts", "other\n"));
					expect(
						yield* cache.files(repo.root, "main", undefined, true),
					).toBeUndefined();
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("a confirmed target awaits matching in-flight speculation without exposing an unconfirmed candidate", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file.ts", "base\n");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.write("file.ts", "head\n");
		await repo.commit("head");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const gate = yield* Deferred.make<void>();
					const started = yield* Deferred.make<void>();
					const preparation = yield* makeDiffPreparation();
					const cache = yield* makeSpeculativeDiff({
						read: (root, base, options) =>
							Deferred.succeed(started, undefined).pipe(
								Effect.andThen(Deferred.await(gate)),
								Effect.andThen(preparation.read(root, base, options)),
							),
					});
					const pending = yield* cache.start(repo.root, false, "main");
					yield* Deferred.await(started);
					expect(
						yield* cache.files(repo.root, "main", undefined, false),
					).toBeUndefined();
					yield* cache.confirm(pending, repo.root, "main");
					yield* Deferred.succeed(gate, undefined);
					expect(
						(yield* cache.contents(repo.root, "main", undefined, false, [
							{ path: "file.ts" },
						]))?.get("file.ts")?.newContent,
					).toBe("head\n");
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});
