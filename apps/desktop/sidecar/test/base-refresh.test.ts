import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
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
					now: () => state.now,
				});
				yield* refresh.prepare("repo", "main");
				expect(state.fetches).toBe(0);
				yield* refresh.background("repo", "main");
				yield* Deferred.await(started);
				yield* refresh.background("worktree", "origin/main");
				expect(state.fetches).toBe(1);
				expect(refresh.stale("shared-repo\norigin/main")).toBe(true);
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
