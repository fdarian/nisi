import { expect, test } from "bun:test";
import type { OpenPullRequestIndex } from "@repo/git";
import { Deferred, Effect, Fiber } from "effect";
import { makePrIndex } from "../pr-index.ts";

const entry: OpenPullRequestIndex = {
	repository: { owner: "acme", repo: "widgets", defaultBranch: "main" },
	prs: [
		{
			number: 3,
			title: "Newest",
			baseRef: "main",
			headRef: "feature",
			isCrossRepository: true,
			headOwner: "fork",
		},
		{
			number: 2,
			title: "Older",
			baseRef: "main",
			headRef: "feature",
			isCrossRepository: true,
			headOwner: "fork",
		},
	],
};

test("index matches owner and branch exactly, dedupes refreshes, atomically replaces successful data, retains data on error", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>();
				const state = { calls: 0, fail: false, data: entry };
				const index = yield* makePrIndex(() =>
					Effect.gen(function* () {
						state.calls++;
						yield* Deferred.await(gate);
						if (state.fail) return yield* Effect.fail("offline");
						return state.data;
					}),
				);
				const refresh = yield* index.refresh("root", "acme", "widgets");
				yield* index.refresh("other", "ACME", "Widgets");
				expect(
					index.find("acme", "widgets", "fork", "feature"),
				).toBeUndefined();
				yield* Deferred.succeed(gate, undefined);
				if (refresh === undefined)
					return yield* Effect.die("first refresh not started");
				yield* Fiber.join(refresh);
				expect(state.calls).toBe(1);
				expect(index.findNumber("ACME", "Widgets", 2)?.pr.title).toBe("Older");
				expect(index.findNumber("acme", "other", 2)).toBeUndefined();
				expect(index.findNumber("acme", "widgets", 99)).toBeUndefined();
				expect(
					index.find("acme", "widgets", "fork", "feature")?.pr.number,
				).toBe(3);
				expect(
					index.find("acme", "widgets", "Fork", "feature"),
				).toBeUndefined();
				expect(
					index.find("acme", "widgets", "fork", "Feature"),
				).toBeUndefined();
				state.fail = true;
				const failure = yield* index.refresh("root", "acme", "widgets");
				if (failure === undefined)
					return yield* Effect.die("failure refresh not started");
				yield* Fiber.join(failure);
				expect(
					index.find("acme", "widgets", "fork", "feature")?.pr.number,
				).toBe(3);
				state.fail = false;
				state.data = { ...entry, prs: [] };
				const empty = yield* index.refresh("root", "acme", "widgets");
				if (empty === undefined)
					return yield* Effect.die("empty refresh not started");
				yield* Fiber.join(empty);
				expect(
					index.find("acme", "widgets", "fork", "feature"),
				).toBeUndefined();
			}),
		),
	);
});
