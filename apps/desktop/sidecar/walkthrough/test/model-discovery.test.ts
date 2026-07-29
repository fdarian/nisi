import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { createModelDiscoveryCache } from "../model-discovery.ts";

describe("createModelDiscoveryCache", () => {
	test("a successful discovery is reported fresh and cached for later calls", async () => {
		const cache = createModelDiscoveryCache();
		let calls = 0;
		const discover = Effect.sync(() => {
			calls++;
			return [{ id: "a", label: "A" }];
		});

		const first = await Effect.runPromise(cache.get("codex", discover));
		expect(first).toEqual({
			models: [{ id: "a", label: "A" }],
			status: "fresh",
		});
		expect(calls).toBe(1);

		// Second call within the TTL must not re-run `discover`.
		const second = await Effect.runPromise(cache.get("codex", discover));
		expect(second).toEqual({
			models: [{ id: "a", label: "A" }],
			status: "fresh",
		});
		expect(calls).toBe(1);
	});

	test("a failed discovery with no prior success reports unavailable and an empty list", async () => {
		const cache = createModelDiscoveryCache();
		const discover = Effect.fail(new Error("cli not found"));

		const result = await Effect.runPromise(cache.get("codex", discover));
		expect(result).toEqual({ models: [], status: "unavailable" });
	});

	test("within the TTL, a cache hit is served without re-running discover even if it would now fail", async () => {
		const cache = createModelDiscoveryCache();
		let shouldFail = false;
		const discover = Effect.suspend(() =>
			shouldFail
				? Effect.fail(new Error("cli crashed"))
				: Effect.succeed([{ id: "a", label: "A" }]),
		);

		const primed = await Effect.runPromise(cache.get("opencode", discover));
		expect(primed.status).toBe("fresh");

		shouldFail = true;
		const result = await Effect.runPromise(cache.get("opencode", discover));
		expect(result).toEqual({
			models: [{ id: "a", label: "A" }],
			status: "fresh",
		});
	});

	test("once the TTL expires, a failing re-fetch falls back to the last cached list, flagged stale", async () => {
		// A near-zero TTL forces every call past the cache-hit branch and into a
		// real `discover` re-attempt, without waiting out the real 5-minute TTL.
		const cache = createModelDiscoveryCache(1);
		let shouldFail = false;
		const discover = Effect.suspend(() =>
			shouldFail
				? Effect.fail(new Error("cli crashed"))
				: Effect.succeed([{ id: "a", label: "A" }]),
		);

		const primed = await Effect.runPromise(cache.get("opencode", discover));
		expect(primed.status).toBe("fresh");

		await new Promise((resolve) => setTimeout(resolve, 5));
		shouldFail = true;
		const staleResult = await Effect.runPromise(
			cache.get("opencode", discover),
		);
		expect(staleResult).toEqual({
			models: [{ id: "a", label: "A" }],
			status: "stale",
		});

		// The stale fallback isn't itself re-cached as a fresh success — the
		// next call re-attempts discovery again rather than trusting a failure.
		shouldFail = false;
		await new Promise((resolve) => setTimeout(resolve, 5));
		const recovered = await Effect.runPromise(cache.get("opencode", discover));
		expect(recovered).toEqual({
			models: [{ id: "a", label: "A" }],
			status: "fresh",
		});
	});

	test("independent harness ids don't share cache entries", async () => {
		const cache = createModelDiscoveryCache();
		const codexDiscover = Effect.succeed([{ id: "codex-model", label: "C" }]);
		const openCodeDiscover = Effect.fail(new Error("unreachable"));

		const codexResult = await Effect.runPromise(
			cache.get("codex", codexDiscover),
		);
		const openCodeResult = await Effect.runPromise(
			cache.get("opencode", openCodeDiscover),
		);

		expect(codexResult).toEqual({
			models: [{ id: "codex-model", label: "C" }],
			status: "fresh",
		});
		expect(openCodeResult).toEqual({ models: [], status: "unavailable" });
	});
});
