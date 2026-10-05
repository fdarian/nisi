import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	cleanupTestRepo,
	makeTestRepo,
} from "../../../../packages/git/test/fixtures.ts";
import { resolveOpenRepoRoot } from "../repo-root.ts";

test("provided roots are checked; subdirectories and mismatches still resolve through git", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("nested/file", "base\n");
		await repo.commit("base");
		const root = (await repo.git(["rev-parse", "--show-toplevel"])).trim();
		const read = (cwd: string, provided?: string) =>
			Effect.runPromise(
				resolveOpenRepoRoot(cwd, provided).pipe(
					Effect.provide(BunServices.layer),
				),
			);
		expect(await read(repo.root, repo.root)).toBe(root);
		expect(await read(`${repo.root}/nested`, `${repo.root}/nested`)).toBe(root);
		expect(await read(`${repo.root}/nested`, repo.root)).toBe(root);
		expect(await read(repo.root)).toBe(root);
		await repo.git(["worktree", "add", "-b", "other", `${repo.root}/worktree`]);
		expect(await read(`${repo.root}/worktree`, `${repo.root}/worktree`)).toBe(
			`${root}/worktree`,
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});
