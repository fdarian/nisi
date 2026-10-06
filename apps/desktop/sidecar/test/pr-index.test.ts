import { expect, test } from "bun:test";
import type {
	OpenPullRequestIndex,
	OpenPullRequestIndexOptions,
} from "@repo/git";
import { Deferred, Effect, Fiber, Schedule } from "effect";
import { makePrIndex, makePrIndexMaintenance } from "../pr-index.ts";

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

test("maintenance survives failed settings reads and attention refresh returns before settings", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const state = { calls: 0 };
				const maintenance = yield* makePrIndexMaintenance(
					Effect.suspend(() => {
						state.calls++;
						return state.calls === 1
							? Effect.fail("settings unavailable")
							: Effect.void;
					}),
					Schedule.recurs(1),
				);
				yield* maintenance.start;
				expect(state.calls).toBe(2);
				const started = yield* Deferred.make<void>();
				const gate = yield* Deferred.make<void>();
				const background = yield* makePrIndexMaintenance(
					Effect.gen(function* () {
						yield* Deferred.succeed(started, undefined);
						yield* Deferred.await(gate);
						return yield* Effect.fail("settings unavailable");
					}),
				);
				yield* background.refreshKnown;
				yield* Deferred.await(started);
				yield* Deferred.succeed(gate, undefined);
			}),
		),
	);
});

test("index matches owner case-insensitively and branch exactly, dedupes refreshes and retains data on error", async () => {
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
					index.find("acme", "widgets", "Fork", "feature")?.pr.number,
				).toBe(3);
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

test("incremental pages remove closed and merged PRs immediately and allow a later reopen", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const state = {
					value: {
						...entry,
						highWaterMark: "2026-10-01T00:00:00Z",
					} as OpenPullRequestIndex,
				};
				const index = yield* makePrIndex((_path, _owner, _repo, options) =>
					Effect.gen(function* () {
						if (options?.onPage === undefined)
							return yield* Effect.die("missing callback");
						yield* options.onPage(state.value);
						return state.value;
					}),
				);
				const initial = yield* index.refresh("root", "acme", "widgets");
				if (initial === undefined) return yield* Effect.die("missing refresh");
				yield* Fiber.join(initial);
				state.value = {
					...entry,
					highWaterMark: "2026-10-02T00:00:00Z",
					prs: [],
					removedNumbers: [2, 3],
				};
				const closed = yield* index.refresh("root", "acme", "widgets");
				if (closed === undefined) return yield* Effect.die("missing refresh");
				yield* Fiber.join(closed);
				expect(index.findNumber("acme", "widgets", 2)).toBeUndefined();
				expect(index.findNumber("acme", "widgets", 3)).toBeUndefined();
				state.value = {
					...entry,
					highWaterMark: "2026-10-03T00:00:00Z",
					prs: entry.prs.filter((pr) => pr.number === 3),
				};
				const reopened = yield* index.refresh("root", "acme", "widgets");
				if (reopened === undefined) return yield* Effect.die("missing refresh");
				yield* Fiber.join(reopened);
				expect(index.findNumber("acme", "widgets", 3)).toBeDefined();
			}),
		),
	);
});

test("pages are usable before completion; incremental refreshes retain older PRs and full refreshes drop closed PRs", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const published = yield* Deferred.make<void>();
				const finish = yield* Deferred.make<void>();
				const firstPr = entry.prs[0];
				const oldPr = entry.prs[1];
				if (firstPr === undefined || oldPr === undefined)
					return yield* Effect.die("fixture missing PR");
				const first = { ...entry, highWaterMark: "2026-10-05T01:00:00Z" };
				const state = { time: 0, calls: 0, fail: false };
				const requests: (OpenPullRequestIndexOptions | undefined)[] = [];
				const index = yield* makePrIndex(
					(_path, _owner, _repo, options) =>
						Effect.gen(function* () {
							state.calls++;
							requests.push(options);
							if (options?.onPage === undefined)
								return yield* Effect.die("missing page callback");
							if (state.calls === 1) {
								yield* options.onPage({ ...first, prs: [firstPr] });
								yield* Deferred.succeed(published, undefined);
								yield* Deferred.await(finish);
								yield* options.onPage({ ...first, prs: [oldPr] });
								return first;
							}
							const updated = {
								...first,
								highWaterMark: "2026-10-05T02:00:00Z",
								prs: [{ ...firstPr, title: "Updated", headRef: "new-branch" }],
							};
							yield* options.onPage(updated);
							if (state.fail) return yield* Effect.fail("page failed");
							return updated;
						}),
					() => state.time,
				);
				const initial = yield* index.refresh("root", "acme", "widgets");
				if (initial === undefined)
					return yield* Effect.die("missing initial refresh");
				yield* Deferred.await(published);
				expect(index.findNumber("acme", "widgets", 3)?.pr.title).toBe("Newest");
				expect(
					index.find("acme", "widgets", "fork", "feature")?.pr.number,
				).toBe(3);
				expect(index.findNumber("acme", "widgets", 2)).toBeUndefined();
				expect(yield* index.refresh("root", "acme", "widgets")).toBeUndefined();
				yield* Deferred.succeed(finish, undefined);
				yield* Fiber.join(initial);
				state.fail = true;
				const failed = yield* index.refresh("root", "acme", "widgets");
				if (failed === undefined)
					return yield* Effect.die("missing failed refresh");
				yield* Fiber.join(failed);
				expect(index.findNumber("acme", "widgets", 3)?.pr.title).toBe(
					"Updated",
				);
				expect(index.findNumber("acme", "widgets", 2)?.pr.title).toBe("Older");
				state.fail = false;
				const incremental = yield* index.refresh("root", "acme", "widgets");
				if (incremental === undefined)
					return yield* Effect.die("missing incremental refresh");
				yield* Fiber.join(incremental);
				expect(requests[0]?.updatedSince).toBeUndefined();
				expect(requests[1]?.updatedSince).toBe(first.highWaterMark);
				expect(requests[2]?.updatedSince).toBe(first.highWaterMark);
				expect(index.findNumber("acme", "widgets", 2)).toBeDefined();
				state.time = 30 * 60_000;
				const full = yield* index.refresh("root", "acme", "widgets");
				if (full === undefined)
					return yield* Effect.die("missing full refresh");
				yield* Fiber.join(full);
				expect(requests[3]?.updatedSince).toBeUndefined();
				expect(index.findNumber("acme", "widgets", 2)).toBeUndefined();
				expect(
					index.find("acme", "widgets", "fork", "feature"),
				).toBeUndefined();
				expect(
					index.find("acme", "widgets", "fork", "new-branch")?.pr.number,
				).toBe(3);
			}),
		),
	);
});
