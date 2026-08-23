import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { ReviewStore } from "@repo/review";
import { SettingsStore } from "@repo/settings";
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

/**
 * Regression coverage for the corruption `resolveDiffHead`
 * (`apps/desktop/sidecar/diff-head.ts`) exists to prevent: `setFileViewed`/
 * `setRangeViewed` used to read `readWorktreeBlobContent` unconditionally,
 * so a session whose head wasn't what `repoRoot` actually had checked out —
 * an explicit `<base>..<head>` session, or an ordinary session the caller
 * checked a different branch out from mid-session — would silently
 * snapshot the wrong branch's content on tick.
 */
describe("Store — tracked-changes writes never snapshot the wrong branch's content", () => {
	test("setFileViewed on an explicit non-checkout head snapshots headRef's content, not the live checkout", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "feature content\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			// The actual checkout is a third branch, dirtied on top — none of
			// this may ever leak into a snapshot for a session whose head is
			// the explicit "feature".
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);
			await Bun.write(
				join(repoRoot, "a.ts"),
				"dirtied on working, never committed\n",
			);

			const snapshotText = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
						headRef: "feature",
					});
					yield* store.setFileViewed(session.id, "a.ts", true);
					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					if (state === null || state.snapshotHash === null) {
						return yield* Effect.die("expected a snapshot hash");
					}
					const snapshot = yield* reviewStore.readSnapshot(state.snapshotHash);
					return new TextDecoder().decode(snapshot);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(snapshotText).toBe("feature content\n");
		});
	});

	test("setFileViewed on an ordinary session snapshots headRef's content once the caller checks a different branch out mid-session", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "feature content\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			// Opened while "feature" is checked out — headRef == "feature",
			// the same as any ordinary `nisi diff` session today.
			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
					});
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The caller drifts away mid-session, without closing the tab —
			// before the fix, this alone was enough to corrupt a tick, since
			// the write path always followed the live checkout.
			await sh(repoRoot, ["checkout", "-q", "main"]);
			await Bun.write(
				join(repoRoot, "a.ts"),
				"drifted onto main, never committed\n",
			);

			const snapshotText = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					yield* store.setFileViewed(sessionId, "a.ts", true);
					const state = yield* reviewStore.getFileReviewState(
						sessionId,
						"a.ts",
					);
					if (state === null || state.snapshotHash === null) {
						return yield* Effect.die("expected a snapshot hash");
					}
					const snapshot = yield* reviewStore.readSnapshot(state.snapshotHash);
					return new TextDecoder().decode(snapshot);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(snapshotText).toBe("feature content\n");
		});
	});

	test("setRangeViewed reconciles against the correct merge-base and headRef content once the caller has drifted", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			// `main` keeps moving (and touching a.ts) after "feature" branches
			// off — the merge-base regression only shows up when `main`'s own
			// tip differs from `merge-base(main, feature)`, in a way that
			// introduces a *second*, unrelated change to a.ts (a pure trailing
			// deletion wouldn't be enough — see the range-claim reasoning below).
			await Bun.write(join(repoRoot, "a.ts"), "line1\nline2\nline3\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "three lines on main"]);

			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "line1\nline2 CHANGED\nline3\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			await sh(repoRoot, ["checkout", "-q", "main"]);
			await Bun.write(
				join(repoRoot, "a.ts"),
				"line1 CHANGED ON MAIN\nline2\nline3\n",
			);
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "main advanced"]);

			// Session opened while "feature" is checked out.
			await sh(repoRoot, ["checkout", "-q", "feature"]);
			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// Drift to "main", which has since moved past the true
			// merge-base(main, feature) — the case that exposed the bug.
			await sh(repoRoot, ["checkout", "-q", "main"]);

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					// Only claims line 2 — feature's one real change relative
					// to the *correct* merge-base. Against the wrong base
					// (main's own drifted tip, which also differs from feature
					// on line 1), reconciliation would find an extra
					// unreviewed line-1 hunk this claim never covers.
					yield* store.setRangeViewed(
						sessionId,
						"a.ts",
						"block-1",
						"Block 1",
						[{ startLine: 2, endLine: 2 }],
						true,
					);
					const claims = yield* reviewStore.listRangeClaims(sessionId, "a.ts");
					const claim = claims.find((c) => c.blockId === "block-1");
					if (claim === undefined) {
						return yield* Effect.die("expected a range claim");
					}
					const snapshot = yield* reviewStore.readSnapshot(claim.snapshotHash);
					const fileState = yield* reviewStore.getFileReviewState(
						sessionId,
						"a.ts",
					);
					return {
						rangeSnapshotText: new TextDecoder().decode(snapshot),
						wholeFileAutoTicked: fileState?.viewed ?? false,
					};
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The range claim itself must snapshot "feature"'s content, not
			// whatever's dirtied on the live "main" checkout.
			expect(result.rangeSnapshotText).toBe("line1\nline2 CHANGED\nline3\n");
			// Claiming just line 2 fully covers merge-base(main,
			// feature)..feature's one real hunk, so the whole-file claim
			// should auto-tick — which only happens if reconciliation used
			// that correct base rather than merge-base(main, HEAD) against a
			// drifted "main" that also differs from feature on line 1.
			expect(result.wholeFileAutoTicked).toBe(true);
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
					const settingsStore = yield* SettingsStore;
					// `includeUncommitted: true` — "current" has to mean the
					// working tree (still missing the file) for both the write
					// and the read to exercise the absent-stays-reviewed path;
					// committed-only mode would read `a.ts` from `feature`'s
					// committed tree instead, where it still exists.
					yield* settingsStore.update({ includeUncommitted: true });

					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});

					yield* store.setFileViewed(session.id, "a.ts", true);

					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
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
					const settingsStore = yield* SettingsStore;
					// Worktree mode — a directory colliding with the tracked path
					// is only a read failure when the write actually touches the
					// worktree; committed-only mode reads the git object instead
					// and never sees the stray directory on disk.
					yield* settingsStore.update({ includeUncommitted: true });

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

/**
 * Regression coverage for the bug `readCurrentContent`'s consolidation
 * (`apps/desktop/sidecar/store.ts`) fixed: `setFileViewed`/`setRangeViewed`
 * used to snapshot via a helper that read the worktree whenever the session
 * was worktree-eligible, regardless of the `includeUncommitted` setting,
 * while `listChangedFiles`'s `attachReviewState` only read the worktree when
 * `includeUncommitted` was *also* on. With the setting off (the default),
 * ticking Reviewed snapshotted the worktree while the very next read
 * compared against HEAD's committed tree, so a deleted-but-still-present-
 * on-disk file (e.g. a gitignored leftover at the same path) reported
 * "Modified after review" immediately, with nothing about the committed
 * diff actually different. Both the write and the read now derive "current
 * content" from the same gate, and the changed-since-review comparison
 * (`hasChangedSinceReview`) treats absence symmetrically instead of
 * standing in `hashContent(new Uint8Array())` for it — a real hash that
 * could never equal a real snapshot.
 */
describe("Store — setFileViewed and listChangedFiles agree on 'current content'", () => {
	test("reviewed-then-still-deleted: stays unchanged in committed-only mode even with a stray untracked file at that path", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await rm(join(repoRoot, "a.ts"));
			await sh(repoRoot, ["commit", "-q", "-am", "delete a.ts"]);

			// A leftover, untracked file at the same path (e.g. gitignored) —
			// physically present on disk despite being deleted from git's
			// history. `includeUncommitted` defaults to `false`, so neither the
			// write nor the read below may ever look at this.
			await Bun.write(join(repoRoot, "a.ts"), "stray untracked content\n");

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
					const files = yield* store.listChangedFiles(session.id, false);
					const file = files.find((f) => f.path === "a.ts");
					return { state, review: file?.review ?? null };
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(result.state?.snapshotHash).toBeNull();
			expect(result.review).toEqual({
				viewed: true,
				reviewedHash: null,
				changedSinceReview: false,
			});
		});
	});

	test("a committed-only tick never snapshots a dirty uncommitted edit sitting in the worktree", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "feature content\n");
			await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);

			// Dirtied on top, never committed — with `includeUncommitted: false`
			// this must be invisible to both the write and the read.
			await Bun.write(join(repoRoot, "a.ts"), "dirtied, never committed\n");

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
					if (state === null || state.snapshotHash === null) {
						return yield* Effect.die("expected a snapshot hash");
					}
					const snapshot = yield* reviewStore.readSnapshot(state.snapshotHash);
					const files = yield* store.listChangedFiles(session.id, false);
					const file = files.find((f) => f.path === "a.ts");
					return {
						snapshotText: new TextDecoder().decode(snapshot),
						changedSinceReview: file?.review?.changedSinceReview ?? null,
					};
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The snapshot must be `feature`'s committed content, not the dirty
			// worktree edit — and the immediate read must agree.
			expect(result.snapshotText).toBe("feature content\n");
			expect(result.changedSinceReview).toBe(false);
		});
	});

	test("a file that reappears after being reviewed while absent is reported changed", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "hello\nworld\n");
			await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);
			await rm(join(repoRoot, "a.ts"));

			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const settingsStore = yield* SettingsStore;
					// Worktree mode, so the write sees the file as genuinely
					// absent right now (not merely absent from HEAD).
					yield* settingsStore.update({ includeUncommitted: true });
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});
					yield* store.setFileViewed(session.id, "a.ts", true);
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The file shows back up on disk, uncommitted.
			await Bun.write(join(repoRoot, "a.ts"), "back again\n");

			const changedSinceReview = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const files = yield* store.listChangedFiles(sessionId, true);
					return (
						files.find((f) => f.path === "a.ts")?.review?.changedSinceReview ??
						null
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(changedSinceReview).toBe(true);
		});
	});

	test("a file deleted after being reviewed while present is reported changed", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "hello\nworld\n");
			await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);

			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const settingsStore = yield* SettingsStore;
					yield* settingsStore.update({ includeUncommitted: true });
					const session = yield* store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					});
					yield* store.setFileViewed(session.id, "a.ts", true);
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			await rm(join(repoRoot, "a.ts"));

			const changedSinceReview = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const files = yield* store.listChangedFiles(sessionId, true);
					return (
						files.find((f) => f.path === "a.ts")?.review?.changedSinceReview ??
						null
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(changedSinceReview).toBe(true);
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
