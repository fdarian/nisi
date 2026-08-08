import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { ReviewStore } from "../src/store.ts";
import { makeTestLayer, withTempDataDir } from "./fixtures.ts";

const run = <A, E>(
	dataDir: string,
	effect: Effect.Effect<A, E, ReviewStore | FileSystem>,
) => Effect.runPromise(effect.pipe(Effect.provide(makeTestLayer(dataDir))));

const prInput = {
	repoRoot: "/repo",
	baseRef: "main",
	headRef: "feature",
	pr: { number: 42, title: "Add widgets", owner: "acme", repo: "widgets" },
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
			expect(session.pr).toEqual({
				number: 42,
				title: "Add widgets",
				owner: "acme",
				repo: "widgets",
			});
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
						pr: { ...prInput.pr, title: "Add widgets (renamed)" },
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

	test("two no-PR sessions on the same branch but different bases are distinct, each keeping its own baseRef", async () => {
		await withTempDataDir(async (dataDir) => {
			const [onMain, onDevelop, open] = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const a = yield* store.openSession({
						...prInput,
						pr: null,
						baseRef: "main",
					});
					const b = yield* store.openSession({
						...prInput,
						pr: null,
						baseRef: "develop",
					});
					const listed = yield* store.listOpenSessions();
					return [a, b, listed] as const;
				}),
			);

			expect(onDevelop.id).not.toBe(onMain.id);
			expect(open).toHaveLength(2);
			expect([...open].map((session) => session.baseRef).sort()).toEqual([
				"develop",
				"main",
			]);
		});
	});

	test("two working copies of the same PR are two sessions, each keeping its own repoRoot", async () => {
		await withTempDataDir(async (dataDir) => {
			const [first, second, open] = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const a = yield* store.openSession(prInput);
					const b = yield* store.openSession({
						...prInput,
						repoRoot: "/other-clone",
					});
					const listed = yield* store.listOpenSessions();
					return [a, b, listed] as const;
				}),
			);

			expect(second.id).not.toBe(first.id);
			expect(open).toHaveLength(2);
			expect([...open].map((session) => session.repoRoot).sort()).toEqual([
				"/other-clone",
				"/repo",
			]);
		});
	});

	test("a session with no PR at all opens and reuses its branch-keyed row", async () => {
		await withTempDataDir(async (dataDir) => {
			const [first, second] = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const localOnly = { ...prInput, pr: null };
					const a = yield* store.openSession(localOnly);
					const b = yield* store.openSession(localOnly);
					return [a, b] as const;
				}),
			);

			expect(first.pr).toBeNull();
			expect(second.id).toBe(first.id);
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
						Option.some(new TextEncoder().encode("content\n")),
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
						Option.some(new TextEncoder().encode("content\n")),
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
						Option.some(new TextEncoder().encode("x")),
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);
			expect(exit._tag).toBe("Failure");
		});
	});
});

describe("ReviewStore range claims", () => {
	test("markRangeViewed snapshots content and is reflected by listRangeClaims", async () => {
		await withTempDataDir(async (dataDir) => {
			const claims = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-1",
						"Session refresh",
						[{ startLine: 5, endLine: 9 }],
						new TextEncoder().encode("content\n"),
					);
					return yield* store.listRangeClaims(session.id, "src/a.ts");
				}),
			);

			expect(claims).toHaveLength(1);
			expect(claims[0]?.blockId).toBe("block-1");
			expect(claims[0]?.blockLabel).toBe("Session refresh");
			expect(claims[0]?.ranges).toEqual([{ startLine: 5, endLine: 9 }]);
			expect(claims[0]?.snapshotHash).toBeTruthy();
		});
	});

	test("two blocks claiming the same file coexist as separate claims", async () => {
		await withTempDataDir(async (dataDir) => {
			const claims = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-1",
						"First",
						[{ startLine: 1, endLine: 3 }],
						new TextEncoder().encode("content\n"),
					);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-2",
						"Second",
						[{ startLine: 10, endLine: 12 }],
						new TextEncoder().encode("content\n"),
					);
					return yield* store.listRangeClaims(session.id, "src/a.ts");
				}),
			);

			expect(claims).toHaveLength(2);
			expect(new Set(claims.map((c) => c.blockId))).toEqual(
				new Set(["block-1", "block-2"]),
			);
		});
	});

	test("re-ticking the same block+path updates ranges and snapshot in place, not accumulating rows", async () => {
		await withTempDataDir(async (dataDir) => {
			const claims = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-1",
						"First",
						[{ startLine: 1, endLine: 3 }],
						new TextEncoder().encode("v1\n"),
					);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-1",
						"First (renamed)",
						[{ startLine: 1, endLine: 5 }],
						new TextEncoder().encode("v2\n"),
					);
					return yield* store.listRangeClaims(session.id, "src/a.ts");
				}),
			);

			expect(claims).toHaveLength(1);
			expect(claims[0]?.blockLabel).toBe("First (renamed)");
			expect(claims[0]?.ranges).toEqual([{ startLine: 1, endLine: 5 }]);
		});
	});

	test("unmarkRangeViewed removes exactly the claim for its own block, leaving others", async () => {
		await withTempDataDir(async (dataDir) => {
			const claims = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-1",
						"First",
						[{ startLine: 1, endLine: 3 }],
						new TextEncoder().encode("content\n"),
					);
					yield* store.markRangeViewed(
						session.id,
						"src/a.ts",
						"block-2",
						"Second",
						[{ startLine: 10, endLine: 12 }],
						new TextEncoder().encode("content\n"),
					);
					yield* store.unmarkRangeViewed(session.id, "src/a.ts", "block-1");
					return yield* store.listRangeClaims(session.id, "src/a.ts");
				}),
			);

			expect(claims).toHaveLength(1);
			expect(claims[0]?.blockId).toBe("block-2");
		});
	});

	test("listRangeClaims is empty for a file never claimed", async () => {
		await withTempDataDir(async (dataDir) => {
			const claims = await run(
				dataDir,
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					const session = yield* store.openSession(prInput);
					return yield* store.listRangeClaims(session.id, "src/untouched.ts");
				}),
			);
			expect(claims).toHaveLength(0);
		});
	});

	test("markRangeViewed fails with SessionNotFound for an unknown session", async () => {
		await withTempDataDir(async (dataDir) => {
			const exit = await Effect.runPromiseExit(
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					return yield* store.markRangeViewed(
						"does-not-exist",
						"src/a.ts",
						"block-1",
						"First",
						[{ startLine: 1, endLine: 3 }],
						new TextEncoder().encode("x"),
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);
			expect(exit._tag).toBe("Failure");
		});
	});
});
