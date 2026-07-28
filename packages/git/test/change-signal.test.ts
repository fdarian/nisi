import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	readRepoChangeSignature,
	repoChangeSignatureEquals,
} from "../src/change-signal.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("readRepoChangeSignature / repoChangeSignatureEquals", () => {
	test("is stable across reads when nothing changed", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.write("a.ts", "uncommitted\n");

			const first = await run(readRepoChangeSignature(repo.root));
			const second = await run(readRepoChangeSignature(repo.root));
			expect(repoChangeSignatureEquals(first, second)).toBe(true);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("differs after an mtime/size-changing edit to a tracked file", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			await repo.write("a.ts", "uncommitted\n");
			const before = await run(readRepoChangeSignature(repo.root));

			// Ensure the filesystem's mtime resolution can't coincidentally
			// collide with the previous write.
			await new Promise((resolve) => setTimeout(resolve, 10));
			await repo.write("a.ts", "uncommitted, then edited again\n");
			const after = await run(readRepoChangeSignature(repo.root));

			expect(repoChangeSignatureEquals(before, after)).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("differs when a new untracked file appears", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			const before = await run(readRepoChangeSignature(repo.root));

			await repo.write("b.ts", "new file\n");
			const after = await run(readRepoChangeSignature(repo.root));

			expect(repoChangeSignatureEquals(before, after)).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("differs after a new commit moves HEAD, even with a clean worktree", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			const before = await run(readRepoChangeSignature(repo.root));

			await repo.write("a.ts", "hello again\n");
			await repo.commit("second commit");
			const after = await run(readRepoChangeSignature(repo.root));

			expect(repoChangeSignatureEquals(before, after)).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("returns to equal once a file is edited back and status reports it clean again", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");
			const clean = await run(readRepoChangeSignature(repo.root));

			await repo.write("a.ts", "dirtied\n");
			const dirty = await run(readRepoChangeSignature(repo.root));
			expect(repoChangeSignatureEquals(clean, dirty)).toBe(false);

			await repo.write("a.ts", "hello\n");
			const revertedRaw = await run(readRepoChangeSignature(repo.root));
			// `status --porcelain` no longer reports `a.ts` at all once its
			// content matches HEAD again — the file drops out of `files`
			// entirely, which is itself a real, detectable difference.
			expect(revertedRaw.files.has("a.ts")).toBe(false);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
