import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import type { HarnessModel } from "@repo/sidecar-api";
import { eq } from "drizzle-orm";
import { ConfigProvider, Deferred, Effect, Layer } from "effect";
import { harnessModelDiscoveries } from "../db/schema.ts";
import { HarnessModelCache } from "../model-store.ts";

/** Same composition as `apps/desktop/sidecar/test/store.test.ts`'s `makeTestLayer` — `SqliteDb` pinned at a throwaway `NISI_DATA_DIR` so each test gets its own `app.db`. */
const makeTestLayer = (dataDir: string) =>
	HarnessModelCache.layer.pipe(
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

/** `SqliteDb` alone, no `HarnessModelCache` — for seeding/reading rows directly, bypassing the cache's own read/write path, so a test can set up a scenario (an old `fetchedAt`, a run of failures) the cache's own API has no way to produce quickly. */
const makeDbLayer = (dataDir: string) =>
	SqliteDb.layer.pipe(
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

const MODEL: HarnessModel = { id: "m", label: "M" };

let dataDir: string;

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), "nisi-harness-model-cache-"));
});

afterEach(async () => {
	await rm(dataDir, { recursive: true, force: true });
});

/** Runs `cache.get(...)` against a *fresh* `HarnessModelCache` instance (its own in-memory `inFlight` map) but the same on-disk `app.db` — proves persistence survives what a sidecar restart looks like, rather than only ever hitting one long-lived service instance the way the old in-memory `Map` cache could only be tested. */
const get = (
	id: "codex" | "claude-code" | "opencode" | "pi",
	discover: () => Effect.Effect<ReadonlyArray<HarnessModel>, unknown>,
	opts?: { readonly force?: boolean },
) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const cache = yield* HarnessModelCache;
			return yield* cache.get(id, discover, opts);
		}).pipe(Effect.provide(makeTestLayer(dataDir))),
	);

/** Ensures the table exists (via `HarnessModelCache`'s own migration) and writes a row straight through `SqliteDb`, bypassing `get`'s decision logic entirely — the only way to seed a row whose `fetchedAt`/`lastAttemptAt` are already outside the TTL/backoff window without waiting real hours. */
const seedRow = async (values: {
	readonly harnessId: "codex";
	readonly modelsJson: string | null;
	readonly fetchedAt: Date | null;
	readonly lastAttemptAt: Date;
	readonly consecutiveFailures: number;
}) => {
	// Touch the cache once so its migration has created the table.
	await get("codex", () => Effect.fail(new Error("unused"))).catch(() => {});
	await Effect.runPromise(
		Effect.gen(function* () {
			const db = yield* SqliteDb;
			yield* db.delete(harnessModelDiscoveries);
			yield* db.insert(harnessModelDiscoveries).values(values);
		}).pipe(Effect.provide(makeDbLayer(dataDir))),
	);
};

const readRow = () =>
	Effect.runPromise(
		Effect.gen(function* () {
			const db = yield* SqliteDb;
			const rows = yield* db
				.select()
				.from(harnessModelDiscoveries)
				.where(eq(harnessModelDiscoveries.harnessId, "codex"));
			return rows[0];
		}).pipe(Effect.provide(makeDbLayer(dataDir))),
	);

describe("HarnessModelCache — cold", () => {
	test("blocks on discovery and returns the live result", async () => {
		let calls = 0;
		const result = await get("codex", () => {
			calls++;
			return Effect.succeed([MODEL]);
		});
		expect(result).toEqual({ models: [MODEL], status: "fresh" });
		expect(calls).toBe(1);

		const row = await readRow();
		expect(row?.consecutiveFailures).toBe(0);
		expect(row?.fetchedAt).not.toBeNull();
	});

	test("a failing first attempt blocks, persists the failure, and reports unavailable — not empty-and-forgotten", async () => {
		const result = await get("codex", () =>
			Effect.fail(new Error("cli not found")),
		);
		expect(result).toEqual({ models: [], status: "unavailable" });

		const row = await readRow();
		expect(row?.consecutiveFailures).toBe(1);
		expect(row?.fetchedAt).toBeNull();
		expect(row?.lastError).toContain("cli not found");
	});
});

describe("HarnessModelCache — warm and fresh", () => {
	test("served from the row without calling discover again", async () => {
		let calls = 0;
		const discover = () => {
			calls++;
			return Effect.succeed([MODEL]);
		};

		const first = await get("codex", discover);
		expect(first.status).toBe("fresh");
		expect(calls).toBe(1);

		const second = await get("codex", discover);
		expect(second).toEqual({ models: [MODEL], status: "fresh" });
		expect(calls).toBe(1);
	});
});

describe("HarnessModelCache — warm and stale (past the 24h TTL)", () => {
	test("serves the last good list immediately and revalidates in the background", async () => {
		const oldModel: HarnessModel = { id: "old", label: "Old" };
		await seedRow({
			harnessId: "codex",
			modelsJson: JSON.stringify([oldModel]),
			fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
			lastAttemptAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
			consecutiveFailures: 0,
		});

		const newModel: HarnessModel = { id: "new", label: "New" };

		// `Effect.forkDetach` means the background revalidation this triggers
		// keeps running after `cache.get` itself returns — so, unlike every
		// other test here, this one keeps the *same* provided layer (the same
		// live `SqliteDb` connection) open across the trigger, the wait, and
		// the row read, all in one `Effect.runPromise`/`Effect.provide` call.
		// Tearing the layer down right after `get` resolves (the way the
		// `get`/`readRow` helpers above do for every other test) would close
		// the connection out from under the still-running background fiber —
		// a real gotcha worth documenting, not just a test artifact: it's
		// exactly why `index.ts` provides `HarnessModelCache`'s layer around
		// the sidecar's whole `Effect.never`-ending lifetime rather than
		// per-request, so a detached background write always outlives the
		// request that triggered it.
		const row = await Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* HarnessModelCache;
				const started = yield* Deferred.make<void>();
				const discover = () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined);
						return [newModel];
					});

				const served = yield* cache.get("codex", discover);
				// The caller gets the *old* list back immediately, flagged
				// stale — it must never block on the revalidation it just kicked
				// off.
				expect(served).toEqual({ models: [oldModel], status: "stale" });

				yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));
				yield* Effect.sleep("50 millis");

				const db = yield* SqliteDb;
				const rows = yield* db
					.select()
					.from(harnessModelDiscoveries)
					.where(eq(harnessModelDiscoveries.harnessId, "codex"));
				return rows[0];
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);

		expect(row?.modelsJson).toBe(JSON.stringify([newModel]));
		expect(row?.consecutiveFailures).toBe(0);
	});
});

describe("HarnessModelCache — failure backoff", () => {
	test("a stale row that just failed is NOT revalidated again immediately (backoff in effect)", async () => {
		await seedRow({
			harnessId: "codex",
			modelsJson: JSON.stringify([MODEL]),
			fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
			lastAttemptAt: new Date(), // failed just now
			consecutiveFailures: 1,
		});

		let calls = 0;
		const result = await get("codex", () => {
			calls++;
			return Effect.succeed([{ id: "should-not-appear", label: "x" }]);
		});

		// Still serves the old good list -- a failure never hides it -- and
		// does not spawn a new probe while backed off.
		expect(result).toEqual({ models: [MODEL], status: "stale" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(calls).toBe(0);
	});

	test("once the backoff window has elapsed, revalidation resumes", async () => {
		await seedRow({
			harnessId: "codex",
			modelsJson: JSON.stringify([MODEL]),
			fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
			// One prior failure backs off for ~1 minute (base backoff) -- three
			// hours ago is well past that.
			lastAttemptAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
			consecutiveFailures: 1,
		});

		// Same "keep one layer open across the trigger and the wait" shape as
		// the "warm and stale" test above — the revalidation this test
		// confirms actually starts is a background `Effect.forkDetach` fiber
		// that must not have its connection torn out from under it.
		await Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* HarnessModelCache;
				const started = yield* Deferred.make<void>();
				const result = yield* cache.get("codex", () =>
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined);
						return [{ id: "recovered", label: "Recovered" }];
					}),
				);
				expect(result.status).toBe("stale");
				yield* Deferred.await(started).pipe(Effect.timeout("2 seconds"));
				// `started` fires before the background fiber's own write, not
				// after — give that write a moment to actually land before this
				// scope (and its `SqliteDb` connection) tears down, same as the
				// "warm and stale" test above.
				yield* Effect.sleep("50 millis");
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);
	});

	test("a failure never overwrites a previously-good model list, only the failure bookkeeping", async () => {
		await get("codex", () => Effect.succeed([MODEL]));
		const beforeRow = await readRow();
		expect(beforeRow?.consecutiveFailures).toBe(0);

		// Force a failing re-fetch.
		const result = await get("codex", () => Effect.fail(new Error("boom")), {
			force: true,
		});
		expect(result).toEqual({ models: [MODEL], status: "stale" });

		const afterRow = await readRow();
		expect(afterRow?.modelsJson).toBe(beforeRow?.modelsJson);
		expect(afterRow?.consecutiveFailures).toBe(1);
	});
});

describe("HarnessModelCache — force", () => {
	test("bypasses the TTL, re-running discover even when the row is fresh", async () => {
		let calls = 0;
		const discover = () => {
			calls++;
			return Effect.succeed([{ id: `a${calls}`, label: `A${calls}` }]);
		};

		const first = await get("codex", discover);
		expect(first.status).toBe("fresh");
		expect(calls).toBe(1);

		const forced = await get("codex", discover, { force: true });
		expect(forced).toEqual({
			models: [{ id: "a2", label: "A2" }],
			status: "fresh",
		});
		expect(calls).toBe(2);
	});
});

describe("HarnessModelCache — single-flight", () => {
	test("concurrent callers for the same harness share one discovery instead of each spawning their own", async () => {
		let spawns = 0;
		// A real `Effect.sleep` (rather than an externally-released gate) is
		// enough to hold the leader open across all three callers' own
		// synchronous single-flight check (`Ref.modify`) — those run
		// effectively immediately, well before a 30ms sleep resolves, so by
		// the time the leader wakes up every follower has already joined its
		// `Deferred` rather than raced it into becoming its own leader.
		const discover = () =>
			Effect.gen(function* () {
				spawns++;
				yield* Effect.sleep("30 millis");
				return [MODEL];
			});

		const program = Effect.gen(function* () {
			const cache = yield* HarnessModelCache;
			return yield* Effect.all(
				[
					cache.get("codex", discover),
					cache.get("codex", discover),
					cache.get("codex", discover),
				],
				{ concurrency: "unbounded" },
			);
		});

		const results = await Effect.runPromise(
			program.pipe(Effect.provide(makeTestLayer(dataDir))),
		);

		expect(spawns).toBe(1);
		for (const result of results) {
			expect(result).toEqual({ models: [MODEL], status: "fresh" });
		}
	});

	test("independent harness ids don't share an in-flight slot", async () => {
		const codexDiscover = () =>
			Effect.succeed([{ id: "codex-model", label: "C" }]);
		const openCodeDiscover = () => Effect.fail(new Error("unreachable"));

		const codexResult = await get("codex", codexDiscover);
		const openCodeResult = await Effect.runPromise(
			Effect.gen(function* () {
				const cache = yield* HarnessModelCache;
				return yield* cache.get("opencode", openCodeDiscover);
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);

		expect(codexResult).toEqual({
			models: [{ id: "codex-model", label: "C" }],
			status: "fresh",
		});
		expect(openCodeResult).toEqual({ models: [], status: "unavailable" });
	});
});
