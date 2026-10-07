import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { makeBaseRefresh } from "../base-refresh.ts";

test("local base opens without waiting; background fetch is shared and reports movement", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>();
				const started = yield* Deferred.make<void>();
				const state = {
					commit: "old",
					fetches: 0,
					probes: 0,
					moved: [] as string[],
					now: 0,
				};
				const refresh = yield* makeBaseRefresh({
					identity: () =>
						Effect.sync(() => {
							state.probes++;
							return { key: "shared-repo\norigin/main", commit: state.commit };
						}),
					fetch: () =>
						Effect.gen(function* () {
							state.fetches++;
							yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(gate);
							state.commit = state.fetches < 3 ? "new" : "newer";
							return { baseRef: "origin/main", baseMayBeStale: false };
						}),
					moved: (key) =>
						Effect.sync(() => {
							state.moved.push(key);
						}),
					staleChanged: () =>
						Effect.die("a clean fetch must not flip staleness"),
					now: () => state.now,
				});
				yield* refresh.prepare("repo", "main");
				expect(state.fetches).toBe(0);
				yield* refresh.background("repo", "main");
				yield* Deferred.await(started);
				yield* refresh.background("worktree", "origin/main");
				expect(state.fetches).toBe(1);
				expect(refresh.stale("shared-repo\norigin/main")).toBe(false);
				yield* Deferred.succeed(gate, undefined);
				yield* refresh.refresh("repo", "main");
				expect(state.moved).toEqual(["shared-repo\norigin/main"]);
				yield* refresh.refresh("repo", "main");
				expect(state.fetches).toBe(1);
				expect(refresh.stale("shared-repo\norigin/main")).toBe(false);
				state.now = 5_001;
				const probes = state.probes;
				yield* refresh.prepare("repo", "main", true);
				yield* refresh.background("repo", "main");
				expect(state.probes).toBeGreaterThan(probes);
				yield* refresh.refresh("repo", "main");
				expect(state.fetches).toBe(2);
				expect(state.moved).toHaveLength(1);
				state.now = 3_600_000;
				yield* refresh.prepare("repo", "main");
				yield* refresh.background("repo", "main");
				yield* refresh.refresh("repo", "main");
				expect(state.fetches).toBe(3);
				expect(state.moved).toHaveLength(2);
			}),
		),
	);
});

test("missing local base blocks until the initial fetch completes", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const state: { commit: string | null; fetches: number } = {
					commit: null,
					fetches: 0,
				};
				const refresh = yield* makeBaseRefresh({
					identity: () =>
						Effect.succeed({ key: "repo\norigin/main", commit: state.commit }),
					fetch: () =>
						Effect.sync(() => {
							state.fetches++;
							state.commit = "fetched";
							return { baseRef: "origin/main", baseMayBeStale: false };
						}),
					moved: () => Effect.die("initial fetch must not report movement"),
					staleChanged: () => Effect.void,
					now: () => 0,
				});
				yield* refresh.prepare("repo", "main");
				expect(state.commit).toBe("fetched");
				yield* refresh.background("repo", "main");
				expect(state.fetches).toBe(1);
			}),
		),
	);
});

test("a waiter interrupted mid-fetch does not cancel the shared fetch for later callers", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>();
				const started = yield* Deferred.make<void>();
				const state = { fetches: 0 };
				const refresh = yield* makeBaseRefresh({
					identity: () =>
						Effect.succeed({ key: "repo\norigin/main", commit: "same" }),
					fetch: () =>
						Effect.gen(function* () {
							state.fetches++;
							yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(gate);
							return { baseRef: "origin/main", baseMayBeStale: false };
						}),
					moved: () => Effect.void,
					staleChanged: () => Effect.void,
					now: () => 0,
				});
				const first = yield* Effect.forkChild(refresh.refresh("repo", "main"));
				yield* Deferred.await(started);
				const second = yield* Effect.forkChild(refresh.refresh("repo", "main"));
				yield* Fiber.interrupt(first);
				yield* Deferred.succeed(gate, undefined);
				expect((yield* Fiber.join(second)).baseMayBeStale).toBe(false);
				expect((yield* refresh.refresh("repo", "main")).baseMayBeStale).toBe(
					false,
				);
				expect(state.fetches).toBe(1);
			}),
		),
	);
});

test("a pending fetch is not stale; only a completed failed fetch is, and settling announces the change", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>();
				const started = yield* Deferred.make<void>();
				const state = { stale: true, changed: [] as string[], now: 0 };
				const key = "repo\norigin/main";
				const refresh = yield* makeBaseRefresh({
					identity: () => Effect.succeed({ key, commit: "same" }),
					fetch: () =>
						Effect.gen(function* () {
							yield* Deferred.succeed(started, undefined);
							yield* Deferred.await(gate);
							return { baseRef: "origin/main", baseMayBeStale: state.stale };
						}),
					moved: () => Effect.die("base never moves in this test"),
					staleChanged: (changedKey) =>
						Effect.sync(() => {
							state.changed.push(changedKey);
						}),
					now: () => state.now,
				});
				expect(refresh.stale(key)).toBe(false);
				yield* refresh.prepare("repo", "main");
				yield* refresh.background("repo", "main");
				yield* Deferred.await(started);
				expect(refresh.stale(key)).toBe(false);
				yield* Deferred.succeed(gate, undefined);
				yield* refresh.refresh("repo", "main");
				expect(refresh.stale(key)).toBe(true);
				expect(state.changed).toEqual([key]);

				state.now = 10_000;
				state.stale = false;
				yield* refresh.refresh("repo", "main");
				expect(refresh.stale(key)).toBe(false);
				expect(state.changed).toEqual([key, key]);

				state.now = 20_000;
				yield* refresh.refresh("repo", "main");
				expect(state.changed).toEqual([key, key]);
			}),
		),
	);
});

test("a fetch that errors out counts as stale and announces it", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const changed: string[] = [];
				const key = "repo\norigin/main";
				const refresh = yield* makeBaseRefresh({
					identity: () => Effect.succeed({ key, commit: "same" }),
					fetch: () => Effect.fail("boom"),
					moved: () => Effect.die("base never moves in this test"),
					staleChanged: (changedKey) =>
						Effect.sync(() => {
							changed.push(changedKey);
						}),
					now: () => 0,
				});
				yield* Effect.flip(refresh.refresh("repo", "main"));
				expect(refresh.stale(key)).toBe(true);
				expect(changed).toEqual([key]);
			}),
		),
	);
});

test("a base that moved leaves the staleness announcement to the Refresh button", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const state = { commit: "old", moved: 0, changed: 0 };
				const refresh = yield* makeBaseRefresh({
					identity: () =>
						Effect.sync(() => ({
							key: "repo\norigin/main",
							commit: state.commit,
						})),
					fetch: () =>
						Effect.sync(() => {
							state.commit = "new";
							return { baseRef: "origin/main", baseMayBeStale: true };
						}),
					moved: () =>
						Effect.sync(() => {
							state.moved++;
						}),
					staleChanged: () =>
						Effect.sync(() => {
							state.changed++;
						}),
					now: () => 0,
				});
				yield* refresh.refresh("repo", "main");
				expect(state.moved).toBe(1);
				expect(state.changed).toBe(0);
			}),
		),
	);
});
