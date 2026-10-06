import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { CatFileReaders } from "../src/cat-file.ts";
import { getChangedFiles, getFileContents, prepareDiff } from "../src/diff.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

test("shared prefix conversion preserves classification without reading committed blobs twice", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("base", "base\n");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.write("generated.ts", "// @generated\nexport const x = 1;\n");
		await repo.commit("generated");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const readers = yield* CatFileReaders.make;
					const state = { requests: 0 };
					const prepared = yield* prepareDiff(repo.root, "main").pipe(
						Effect.provideService(CatFileReaders, {
							request: (root, inputs) =>
								Effect.sync(() => {
									state.requests++;
								}).pipe(Effect.andThen(readers.request(root, inputs))),
						}),
					);
					expect(state.requests).toBe(2);
					expect(prepared.prefixes.get("generated.ts")).toBe(
						"// @generated\nexport const x = 1;\n",
					);
					expect(
						(yield* getChangedFiles(repo.root, "main", { prepared })).find(
							(file) => file.path === "generated.ts",
						)?.category,
					).toBe("generated");
					const worktree = yield* prepareDiff(repo.root, "main", {
						includeUncommitted: true,
					});
					expect(worktree.prefixes.get("generated.ts")).toBe(
						prepared.prefixes.get("generated.ts"),
					);
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("combined preparation preserves rename, binary, deleted and quoted path contents and stats", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("old.txt", "old\n");
		await repo.write("delete.txt", "deleted\n");
		await repo.write("tab\tname.txt", "before\n");
		await repo.write("trailing\t", "before\n");
		await repo.commit("base");
		await repo.git(["checkout", "-b", "feature"]);
		await repo.git(["mv", "old.txt", "new.txt"]);
		await repo.git(["rm", "delete.txt"]);
		await repo.write("tab\tname.txt", "after\n");
		await repo.write("trailing\t", "after\n");
		await repo.write("binary.bin", "\0binary");
		await repo.commit("head");
		await Effect.runPromise(
			Effect.gen(function* () {
				const prepared = yield* prepareDiff(repo.root, "main");
				const files = yield* getChangedFiles(repo.root, "main", { prepared });
				expect(files.find((file) => file.path === "new.txt")).toMatchObject({
					status: "renamed",
					oldPath: "old.txt",
					additions: 0,
					deletions: 0,
				});
				expect(
					files.find((file) => file.path === "tab\tname.txt"),
				).toMatchObject({ additions: 1, deletions: 1 });
				expect(files.find((file) => file.path === "trailing\t")).toMatchObject({
					additions: 1,
					deletions: 1,
				});
				expect(files.find((file) => file.path === "binary.bin")?.binary).toBe(
					true,
				);
				const requests = files.map((file) => ({ path: file.path }));
				expect(
					yield* getFileContents(repo.root, "main", requests, { prepared }),
				).toEqual(yield* getFileContents(repo.root, "main", requests));
			}).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});
