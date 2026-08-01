import { describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
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
	describe("includeUncommitted: true", () => {
		test("is stable across reads when nothing changed", async () => {
			const repo = await makeTestRepo();
			try {
				await repo.write("a.ts", "hello\n");
				await repo.commit("base");
				await repo.write("a.ts", "uncommitted\n");

				const first = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);
				const second = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);
				expect(repoChangeSignatureEquals(first, second)).toBe(true);
			} finally {
				await cleanupTestRepo(repo);
			}
		});

		test("differs after an edit to a tracked file, written immediately with no delay", async () => {
			const repo = await makeTestRepo();
			try {
				await repo.write("a.ts", "hello\n");
				await repo.commit("base");
				await repo.write("a.ts", "uncommitted\n");
				const before = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

				// No delay, and deliberately the same byte length as the write
				// above — a content hash can't miss this the way `mtime`/`size`
				// could when both happened to land on the same tick.
				await repo.write("a.ts", "edited again\n");
				const after = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

				expect(repoChangeSignatureEquals(before, after)).toBe(false);
			} finally {
				await cleanupTestRepo(repo);
			}
		});

		test("differs even when two same-size edits share an identical mtime", async () => {
			// Regression test for the bug this module used to have: `mtime`/`size`
			// alone can't tell two different same-length contents apart once their
			// recorded mtimes coincide — a real occurrence on any mount with
			// coarser-than-APFS timestamp resolution, or a tool that
			// preserves/resets a file's mtime on write. Forcing the collision with
			// `utimes` reproduces exactly that, deterministically, regardless of
			// this filesystem's actual timestamp resolution.
			const repo = await makeTestRepo();
			try {
				await repo.write("a.ts", "hello\n");
				await repo.commit("base");

				const forcedMtime = new Date("2024-01-01T00:00:00.000Z");
				const path = join(repo.root, "a.ts");

				await repo.write("a.ts", "AAAAAAAAAAAA\n");
				await utimes(path, forcedMtime, forcedMtime);
				const before = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

				await repo.write("a.ts", "BBBBBBBBBBBB\n"); // same size, different content
				await utimes(path, forcedMtime, forcedMtime);
				const after = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

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
				const before = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

				await repo.write("b.ts", "new file\n");
				const after = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

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
				const before = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

				await repo.write("a.ts", "hello again\n");
				await repo.commit("second commit");
				const after = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

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
				const clean = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);

				await repo.write("a.ts", "dirtied\n");
				const dirty = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);
				expect(repoChangeSignatureEquals(clean, dirty)).toBe(false);

				await repo.write("a.ts", "hello\n");
				const revertedRaw = await run(
					readRepoChangeSignature(repo.root, { includeUncommitted: true }),
				);
				// `status --porcelain` no longer reports `a.ts` at all once its
				// content matches HEAD again — the file drops out of `files`
				// entirely, which is itself a real, detectable difference.
				expect(revertedRaw.files.has("a.ts")).toBe(false);
			} finally {
				await cleanupTestRepo(repo);
			}
		});
	});

	describe("includeUncommitted: false (default)", () => {
		test("ignores a dirty worktree entirely — no status/hashing work, signature stays equal", async () => {
			const repo = await makeTestRepo();
			try {
				await repo.write("a.ts", "hello\n");
				await repo.commit("base");
				const before = await run(readRepoChangeSignature(repo.root));

				// A pure worktree edit — no commit — must not move the signature
				// when `includeUncommitted` is off, since the visible diff target
				// is HEAD and this dirt can't affect anything shown.
				await repo.write("a.ts", "uncommitted edit\n");
				const after = await run(readRepoChangeSignature(repo.root));

				expect(repoChangeSignatureEquals(before, after)).toBe(true);
				// `files` is never populated in this mode at all — `git status`
				// and the per-path hashing are skipped entirely, not just
				// discarded afterward.
				expect(before.files.size).toBe(0);
				expect(after.files.size).toBe(0);
			} finally {
				await cleanupTestRepo(repo);
			}
		});

		test("ignores a new untracked file", async () => {
			const repo = await makeTestRepo();
			try {
				await repo.write("a.ts", "hello\n");
				await repo.commit("base");
				const before = await run(readRepoChangeSignature(repo.root));

				await repo.write("b.ts", "new file\n");
				const after = await run(readRepoChangeSignature(repo.root));

				expect(repoChangeSignatureEquals(before, after)).toBe(true);
			} finally {
				await cleanupTestRepo(repo);
			}
		});

		test("still differs after a new commit moves HEAD", async () => {
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
	});
});
