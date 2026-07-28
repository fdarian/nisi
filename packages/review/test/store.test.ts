import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { ReviewStore } from "../src/store.ts";
import { makeTestLayer, withTempDataDir } from "./fixtures.ts";

const run = <A, E>(
	dataDir: string,
	effect: Effect.Effect<A, E, ReviewStore | FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(makeTestLayer(dataDir))));

const prInput = {
	repoRoot: "/repo",
	owner: "acme",
	repo: "widgets",
	baseRef: "main",
	headRef: "feature",
	pr: { number: 42, title: "Add widgets" },
};

describe("ReviewStore sessions", () => {
	test("openSession creates a session with the given PR", async () => {
		await withTempDataDir(async (dataDir) => {
			const session = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					return yield* store.openSession(prInput);
				}),
			);

			expect(session.repoRoot).toBe("/repo");
			expect(session.pr).toEqual({ number: 42, title: "Add widgets" });
			expect(session.id).toBeTruthy();
		});
	});

	test("openSession is idempotent for the same repo+PR", async () => {
		await withTempDataDir(async (dataDir) => {
			const [first, second, open] = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const a = yield* store.openSession(prInput);
					const b = yield* store.openSession(prInput);
					const listed = yield* store.listOpenSessions();
					return [a, b, listed] as const;
				}),
			);

			expect(second.id).toBe(first.id);
			expect(open).toHaveLength(1);
		});
	});

	test("reopening refreshes the cached PR title", async () => {
		await withTempDataDir(async (dataDir) => {
			const second = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					yield* store.openSession(prInput);
					return yield* store.openSession({
						...prInput,
						pr: { number: 42, title: "Add widgets (renamed)" },
					});
				}),
			);
			expect(second.pr?.title).toBe("Add widgets (renamed)");
		});
	});

	test("a no-PR session is keyed by branch, distinct from a PR session on the same repo", async () => {
		await withTempDataDir(async (dataDir) => {
			const sessions = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const withPr = yield* store.openSession(prInput);
					const withoutPr = yield* store.openSession({ ...prInput, pr: null });
					return [withPr, withoutPr] as const;
				}),
			);
			expect(sessions[0].id).not.toBe(sessions[1].id);
			expect(sessions[1].pr).toBeNull();
		});
	});

	test("closeSession excludes a session from listOpenSessions, but reopening the same repo+PR reuses its id", async () => {
		await withTempDataDir(async (dataDir) => {
			const result = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const opened = yield* store.openSession(prInput);
					yield* store.closeSession(opened.id);
					const afterClose = yield* store.listOpenSessions();
					const reopened = yield* store.openSession(prInput);
					const afterReopen = yield* store.listOpenSessions();
					return { opened, afterClose, reopened, afterReopen };
				}),
			);

			expect(result.afterClose).toHaveLength(0);
			expect(result.reopened.id).toBe(result.opened.id);
			expect(result.afterReopen).toHaveLength(1);
		});
	});

	test("getSession fails with SessionNotFound for an unknown id", async () => {
		await withTempDataDir(async (dataDir) => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					return yield* store.getSession("does-not-exist");
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);
			expect(exit._tag).toBe("Failure");
		});
	});
});

describe("ReviewStore file review state", () => {
	test("markFileViewed snapshots content and is reflected by getFileReviewState", async () => {
		await withTempDataDir(async (dataDir) => {
			const state = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					yield* store.markFileViewed(
						session.id,
						"src/a.ts",
						new TextEncoder().encode("content\n"),
					);
					return yield* store.getFileReviewState(session.id, "src/a.ts");
				}),
			);

			expect(state?.viewed).toBe(true);
			expect(state?.snapshotHash).toBeTruthy();
		});
	});

	test("markFileUnviewed clears the snapshot", async () => {
		await withTempDataDir(async (dataDir) => {
			const state = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					yield* store.markFileViewed(
						session.id,
						"src/a.ts",
						new TextEncoder().encode("content\n"),
					);
					yield* store.markFileUnviewed(session.id, "src/a.ts");
					return yield* store.getFileReviewState(session.id, "src/a.ts");
				}),
			);

			expect(state?.viewed).toBe(false);
			expect(state?.snapshotHash).toBeNull();
		});
	});

	test("getFileReviewState is null for a file never touched", async () => {
		await withTempDataDir(async (dataDir) => {
			const state = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					return yield* store.getFileReviewState(
						session.id,
						"src/untouched.ts",
					);
				}),
			);
			expect(state).toBeNull();
		});
	});

	test("markFileViewed fails with SessionNotFound for an unknown session", async () => {
		await withTempDataDir(async (dataDir) => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					return yield* store.markFileViewed(
						"does-not-exist",
						"src/a.ts",
						new TextEncoder().encode("x"),
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);
			expect(exit._tag).toBe("Failure");
		});
	});
});
