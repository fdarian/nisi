import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { ReviewStore } from "@repo/review";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { Store } from "../store.ts";

/** Runs real `git` for test setup — the code under test uses its own Effect-based runner. */
const sh = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
};

/** A throwaway repo with one commit on `main` — enough for `resolveMergeBase`/`resolveCurrentBranch` to have something real to resolve against. */
const makeTestRepo = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "nisi-sidecar-store-repo-"));
	await sh(root, ["init", "-q", "-b", "main"]);
	await sh(root, ["config", "user.email", "test@example.com"]);
	await sh(root, ["config", "user.name", "Test"]);
	await Bun.write(join(root, "a.ts"), "hello\n");
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", "base"]);
	return root;
};

/** Same composition as `packages/review/test/fixtures.ts`'s `makeTestLayer`, one layer up — `Store.layer` already pulls in `ReviewStore.layer` via `provideMerge`, so this only has to add what `Store.make` needs beyond that: `SqliteDb` and `NISI_DATA_DIR`. */
const makeTestLayer = (dataDir: string) =>
	Store.layer.pipe(
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

const withTestRepoAndDataDir = async <T>(
	fn: (repoRoot: string, dataDir: string) => Promise<T>,
): Promise<T> => {
	const repoRoot = await makeTestRepo();
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-sidecar-store-data-"));
	try {
		return await fn(repoRoot, dataDir);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	}
};

describe("Store.openSession — branch target with an explicit baseRef", () => {
	test("rejects an unresolvable base with InvalidBaseRef, carrying git's own stderr", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "totally-not-a-real-ref",
					});
				}).pipe(Effect.result, Effect.provide(makeTestLayer(dataDir))),
			);

			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure._tag).toBe("InvalidBaseRef");
			if (result.failure._tag !== "InvalidBaseRef") return;
			expect(result.failure.baseRef).toBe("totally-not-a-real-ref");
			expect(result.failure.stderr.length).toBeGreaterThan(0);
		});
	});

	test("still opens normally when the explicit base resolves", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const session = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(session.target).toEqual({
				kind: "branch",
				baseRef: "main",
				headRef: "main",
			});
		});
	});
});

describe("Store.openSession — branch target with an explicit headRef (two arbitrary refs)", () => {
	test("rejects an unresolvable head with InvalidHeadRef, carrying git's own stderr", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
						headRef: "totally-not-a-real-ref",
					});
				}).pipe(Effect.result, Effect.provide(makeTestLayer(dataDir))),
			);

			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure._tag).toBe("InvalidHeadRef");
			if (result.failure._tag !== "InvalidHeadRef") return;
			expect(result.failure.headRef).toBe("totally-not-a-real-ref");
			expect(result.failure.stderr.length).toBeGreaterThan(0);
		});
	});

	test("opens with the explicit head as-is, regardless of what's actually checked out", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "b.ts"), "on feature\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);
			// The actual checkout is a third branch, neither side of the diff.
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);

			const session = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
						headRef: "feature",
					});
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(session.target).toEqual({
				kind: "branch",
				baseRef: "main",
				headRef: "feature",
			});
		});
	});

	test("listChangedFiles diffs the named head, never overlaying uncommitted edits on the actual checkout", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "b.ts"), "on feature\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			// The actual checkout is a third branch, dirtied on top — none of
			// this belongs to the main..feature diff and must never leak in,
			// even when `includeUncommitted` is requested.
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);
			await Bun.write(join(repoRoot, "a.ts"), "dirtied, never committed\n");

			const files = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
						headRef: "feature",
					});
					return yield* store.listChangedFiles(session.id, true);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			const byPath = new Map(files.map((file) => [file.path, file]));
			expect(byPath.get("b.ts")?.status).toBe("added");
			expect(byPath.has("a.ts")).toBe(false);
		});
	});
});

describe("Store.setFileViewed — a committed symlink", () => {
	test("stays reviewed on the next read instead of immediately reporting changedSinceReview", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			// `link.txt` is added on a feature branch cut from `main` — needed so
			// it actually shows up in `listChangedFiles`' base..head diff, not
			// just sitting unchanged in the repo's one existing commit.
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "target.txt"), "target content\n");
			await symlink("target.txt", join(repoRoot, "link.txt"));
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "add symlink"]);

			const files = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
					});
					yield* store.setFileViewed(session.id, "link.txt", true);
					return yield* store.listChangedFiles(session.id, false);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			const linkFile = files.find((file) => file.path === "link.txt");
			expect(linkFile?.review?.viewed).toBe(true);
			expect(linkFile?.review?.changedSinceReview).toBe(false);
		});
	});
});

describe("Store.setFileViewed — working-tree read failures", () => {
	/**
	 * Puts `a.ts` in the session's diff (changed between `main` and a
	 * `feature` branch checked out on top of it) without touching what's
	 * actually on disk right now — each test below mutates the working tree
	 * itself (deletes the file, or replaces it with a directory) after this,
	 * so `a.ts` stays a real diff entry while its current working-tree state
	 * diverges from both `main` and `feature`'s committed content.
	 */
	const makeRepoWithChangedFile = async (repoRoot: string): Promise<void> => {
		await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
		await Bun.write(join(repoRoot, "a.ts"), "hello\nworld\n");
		await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);
	};

	test('ticking Reviewed on a path absent from the working tree records a NULL snapshot, not sha256(""), and still reports it reviewed while absent', async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await makeRepoWithChangedFile(repoRoot);
			await rm(join(repoRoot, "a.ts"));

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});

					yield* store.setFileViewed(session.id, "a.ts", true);

					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					// `includeUncommitted: true` — "current" has to mean the
					// working tree (still missing the file) for this to exercise
					// the absent-stays-reviewed path; committed-only mode would
					// compare against HEAD, where `a.ts` still exists.
					const files = yield* store.listChangedFiles(session.id, true);
					const file = files.find((f) => f.path === "a.ts");
					return { state, review: file?.review ?? null };
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(result.state?.viewed).toBe(true);
			expect(result.state?.snapshotHash).toBeNull();
			expect(result.review).toEqual({
				viewed: true,
				reviewedHash: null,
				changedSinceReview: false,
			});
		});
	});

	test("ticking Reviewed on a path that's actually a directory propagates the read failure instead of recording an empty snapshot", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await makeRepoWithChangedFile(repoRoot);
			await rm(join(repoRoot, "a.ts"));
			await mkdir(join(repoRoot, "a.ts"));

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});

					const outcome = yield* store
						.setFileViewed(session.id, "a.ts", true)
						.pipe(Effect.result);
					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					return { outcome, state };
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(Result.isFailure(result.outcome)).toBe(true);
			// Never recorded as a claim at all — a swallowed error would have
			// left a `viewed: true` row (empty-content snapshot) behind.
			expect(result.state).toBeNull();
		});
	});
});

describe("Store.openPullRequestSession — repo path resolution", () => {
	test("returns needs-repo-path when owner/repo is unknown and nothing can be inferred, without ever shelling out to gh", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-sidecar-store-data-"));
		try {
			const outcome = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* store.openPullRequestSession({
						owner: "fdarian",
						repo: "nisi",
						number: 1,
					});
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(outcome).toEqual({
				status: "needs-repo-path",
				owner: "fdarian",
				repo: "nisi",
			});
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
