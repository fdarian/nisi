import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { fetchBaseRef, resolveDiffBaseRef } from "../src/base.ts";
import { getChangedFiles, getFileContents } from "../src/diff.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

test("remote base excludes upstream additions while local main stays behind", async () => {
	const repo = await makeTestRepo();
	const upstream = await makeTestRepo();
	try {
		await repo.write("base.txt", "base\n");
		const oldMain = await repo.commit("base");
		await upstream.git(["fetch", repo.root, "main"]);
		await upstream.git(["reset", "--hard", "FETCH_HEAD"]);
		await upstream.write("merged.txt", "already merged\n");
		const newMain = await upstream.commit("merged changeset");
		await repo.git(["remote", "add", "origin", upstream.root]);
		await repo.git(["fetch", "origin"]);
		await repo.git(["checkout", "-b", "feature", "origin/main"]);
		await repo.write("pr.txt", "PR change\n");
		await repo.commit("unrelated PR");
		expect((await repo.git(["rev-parse", "main"])).trim()).toBe(oldMain);
		expect(await run(fetchBaseRef(repo.root, "main"))).toEqual({
			baseRef: "refs/remotes/origin/main",
			baseMayBeStale: false,
		});
		expect((await repo.git(["rev-parse", "main"])).trim()).toBe(oldMain);
		expect((await repo.git(["rev-parse", "origin/main"])).trim()).toBe(newMain);
		expect(
			(await run(getChangedFiles(repo.root, "main"))).map((file) => file.path),
		).toEqual(["pr.txt"]);
		expect(
			(
				await run(getFileContents(repo.root, "main", [{ path: "merged.txt" }]))
			).get("merged.txt"),
		).toBeUndefined();
		await repo.git(["remote", "set-url", "origin", `${upstream.root}/missing`]);
		expect((await run(fetchBaseRef(repo.root, "main"))).baseMayBeStale).toBe(
			true,
		);
		expect(
			(await run(getChangedFiles(repo.root, "main"))).map((file) => file.path),
		).toEqual(["pr.txt"]);
		await repo.git(["update-ref", "-d", "refs/remotes/origin/main"]);
		await expect(run(fetchBaseRef(repo.root, "main"))).rejects.toThrow();
		await expect(run(getChangedFiles(repo.root, "main"))).rejects.toThrow();
	} finally {
		await cleanupTestRepo(repo);
		await cleanupTestRepo(upstream);
	}
});

test("no remote keeps local base; non-origin remote and branch slashes are supported", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file.txt", "base\n");
		const sha = await repo.commit("base");
		expect(await run(resolveDiffBaseRef(repo.root, "main"))).toBe("main");
		expect((await run(fetchBaseRef(repo.root, "main"))).baseMayBeStale).toBe(
			false,
		);
		await repo.git(["branch", "release/main"]);
		await repo.git(["remote", "add", "upstream", repo.root]);
		expect((await run(fetchBaseRef(repo.root, "release/main"))).baseRef).toBe(
			"refs/remotes/upstream/release/main",
		);
		expect(await run(resolveDiffBaseRef(repo.root, sha))).toBe(sha);
	} finally {
		await cleanupTestRepo(repo);
	}
});
