import { expect, test } from "bun:test";
import type {
	OpenPullRequestIndex,
	OpenPullRequestIndexOptions,
} from "@repo/git";
import { Deferred, Effect, Fiber, Schedule } from "effect";
import { TestClock } from "effect/testing";
import { subscribe } from "../events.ts";
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
			updatedAt: "2026-10-01T00:00:00Z",
			state: "OPEN",
			author: "alice",
			url: "https://github.com/acme/widgets/pull/1",
			isDraft: false,
		},
		{
			number: 2,
			title: "Older",
			baseRef: "main",
			headRef: "feature",
			isCrossRepository: true,
			headOwner: "fork",
			updatedAt: "2026-10-01T00:00:00Z",
			state: "OPEN",
			author: "alice",
			url: "https://github.com/acme/widgets/pull/1",
			isDraft: false,
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
							: Effect.succeed([]);
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
				yield* Fiber.join(failure);
				expect(
					index.find("acme", "widgets", "fork", "feature")?.pr.number,
				).toBe(3);
				state.fail = false;
				state.data = { ...entry, prs: [] };
				const empty = yield* index.refresh("root", "acme", "widgets");
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
				yield* Fiber.join(initial);
				state.value = {
					...entry,
					highWaterMark: "2026-10-02T00:00:00Z",
					prs: [],
					removedNumbers: [2, 3],
				};
				const closed = yield* index.refresh("root", "acme", "widgets");
				yield* Fiber.join(closed);
				expect(index.findNumber("acme", "widgets", 2)).toBeUndefined();
				expect(index.findNumber("acme", "widgets", 3)).toBeUndefined();
				state.value = {
					...entry,
					highWaterMark: "2026-10-03T00:00:00Z",
					prs: entry.prs.filter((pr) => pr.number === 3),
				};
				const reopened = yield* index.refresh("root", "acme", "widgets");
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
				yield* Deferred.await(published);
				expect(index.findNumber("acme", "widgets", 3)?.pr.title).toBe("Newest");
				expect(
					index.find("acme", "widgets", "fork", "feature")?.pr.number,
				).toBe(3);
				expect(index.findNumber("acme", "widgets", 2)).toBeUndefined();
				expect(yield* index.refresh("root", "acme", "widgets")).toBe(initial);
				yield* Deferred.succeed(finish, undefined);
				yield* Fiber.join(initial);
				state.fail = true;
				const failed = yield* index.refresh("root", "acme", "widgets");
				yield* Fiber.join(failed);
				expect(index.findNumber("acme", "widgets", 3)?.pr.title).toBe(
					"Updated",
				);
				expect(index.findNumber("acme", "widgets", 2)?.pr.title).toBe("Older");
				state.fail = false;
				const incremental = yield* index.refresh("root", "acme", "widgets");
				yield* Fiber.join(incremental);
				expect(requests[0]?.updatedSince).toBeUndefined();
				expect(requests[1]?.updatedSince).toBe(first.highWaterMark);
				expect(requests[2]?.updatedSince).toBe(first.highWaterMark);
				expect(index.findNumber("acme", "widgets", 2)).toBeDefined();
				state.time = 30 * 60_000;
				const full = yield* index.refresh("root", "acme", "widgets");
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

test("indexed lists only OPEN PRs of repos whose refresh completed, in the contract shape, and names the known repos still incomplete", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const gate = yield* Deferred.make<void>();
				const widgets: OpenPullRequestIndex = {
					...entry,
					prs: entry.prs.map((pr) =>
						pr.number === 2 ? { ...pr, state: "CLOSED" as const } : pr,
					),
				};
				const slowEntry = {
					...entry,
					repository: { ...entry.repository, repo: "slow" },
				};
				const index = yield* makePrIndex((_path, _owner, repo, options) =>
					Effect.gen(function* () {
						if (repo === "widgets") return widgets;
						if (options?.onPage !== undefined) yield* options.onPage(slowEntry);
						yield* Deferred.await(gate);
						return slowEntry;
					}),
				);
				const known = [
					{ owner: "acme", repo: "widgets" },
					{ owner: "ACME", repo: "Slow" },
					{ owner: "acme", repo: "never-fetched" },
				];
				expect(index.indexed(known)).toEqual({
					rows: [],
					incompleteRepos: ["acme/widgets", "acme/slow", "acme/never-fetched"],
				});

				yield* Fiber.join(yield* index.refresh("root", "acme", "widgets"));
				const slow = yield* index.refresh("root", "acme", "slow");
				yield* Effect.yieldNow;
				expect(index.findNumber("acme", "slow", 3)).toBeDefined();
				expect(index.indexed(known)).toEqual({
					rows: [
						{
							owner: "acme",
							repo: "widgets",
							number: 3,
							title: "Newest",
							author: "alice",
							updatedAt: "2026-10-01T00:00:00Z",
							url: "https://github.com/acme/widgets/pull/1",
							isDraft: false,
							state: "OPEN",
							headRefName: "feature",
						},
					],
					incompleteRepos: ["acme/slow", "acme/never-fetched"],
				});

				yield* Deferred.succeed(gate, undefined);
				yield* Fiber.join(slow);
				const settled = index.indexed(known);
				expect(settled.rows.map((pr) => `${pr.repo}#${pr.number}`)).toEqual([
					"widgets#3",
					"slow#3",
					"slow#2",
				]);
				expect(settled.incompleteRepos).toEqual(["acme/never-fetched"]);
			}),
		),
	);
});

test("a refresh emits pull-request-index-changed only when it changed something", async () => {
	const events: string[] = [];
	const unsubscribe = subscribe((event) => events.push(event.type));
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const state = {
						fail: false,
						time: 0,
						value: { ...entry, highWaterMark: "2026-10-01T00:00:00Z" },
					};
					const index = yield* makePrIndex(
						(_path, _owner, _repo, options) =>
							Effect.gen(function* () {
								if (options?.onPage !== undefined)
									yield* options.onPage(state.value);
								if (state.fail) return yield* Effect.fail("offline");
								return state.value;
							}),
						() => state.time,
					);
					const refresh = Effect.gen(function* () {
						yield* Fiber.join(yield* index.refresh("root", "acme", "widgets"));
						return events.splice(0);
					});

					state.fail = true;
					expect(yield* refresh).toEqual([]);

					state.fail = false;
					expect(yield* refresh).toEqual(["pull-request-index-changed"]);

					state.value = {
						...entry,
						highWaterMark: "2026-10-02T00:00:00Z",
						prs: [],
					};
					expect(yield* refresh).toEqual([]);

					state.value = {
						...entry,
						highWaterMark: "2026-10-03T00:00:00Z",
						prs: [],
						removedNumbers: [2],
					};
					expect(yield* refresh).toEqual(["pull-request-index-changed"]);

					state.value = {
						...entry,
						highWaterMark: "2026-10-04T00:00:00Z",
						prs: entry.prs.slice(0, 1),
					};
					expect(yield* refresh).toEqual(["pull-request-index-changed"]);

					state.time = 30 * 60_000;
					state.value = {
						...entry,
						highWaterMark: "2026-10-04T00:00:00Z",
						prs: [],
					};
					expect(yield* refresh).toEqual(["pull-request-index-changed"]);
				}),
			),
		);
	} finally {
		unsubscribe();
	}
});

const isSettled = (fiber: Fiber.Fiber<unknown, unknown>) =>
	Effect.gen(function* () {
		for (let turn = 0; turn < 5; turn++) yield* Effect.yieldNow;
		return fiber.pollUnsafe() !== undefined;
	});

test("ready is immediate when no repository is known", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const maintenance = yield* makePrIndexMaintenance(
					Effect.succeed([]),
					Schedule.recurs(0),
				);
				yield* maintenance.start;
				yield* maintenance.ready;
			}),
		),
	);
});

test("ready waits for the boot pass of every repository, including one that fails, and for a refresh already in flight", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const slowGate = yield* Deferred.make<void>();
				const failGate = yield* Deferred.make<void>();
				const index = yield* makePrIndex((_path, _owner, repo) =>
					Effect.gen(function* () {
						yield* Deferred.await(repo === "slow" ? slowGate : failGate);
						if (repo === "broken") return yield* Effect.fail("offline");
						return entry;
					}),
				);
				const inFlight = yield* index.refresh("root", "acme", "slow");
				const maintenance = yield* makePrIndexMaintenance(
					Effect.gen(function* () {
						return [
							yield* index.refresh("root", "acme", "slow"),
							yield* index.refresh("root", "acme", "broken"),
						];
					}),
					Schedule.recurs(0),
				);
				expect(yield* index.refresh("root", "acme", "slow")).toBe(inFlight);
				yield* maintenance.start.pipe(Effect.forkScoped);
				const ready = yield* maintenance.ready.pipe(Effect.forkScoped);

				expect(yield* isSettled(ready)).toBe(false);
				yield* Deferred.succeed(failGate, undefined);
				expect(yield* isSettled(ready)).toBe(false);
				yield* Deferred.succeed(slowGate, undefined);
				yield* Fiber.join(ready);
				expect(index.findNumber("acme", "slow", 3)).toBeDefined();
				expect(index.findNumber("acme", "broken", 3)).toBeUndefined();
			}),
		),
	);
});

test("ready completes even when listing the known repositories fails", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const maintenance = yield* makePrIndexMaintenance(
					Effect.fail("settings unavailable"),
					Schedule.recurs(0),
				);
				yield* maintenance.start;
				yield* maintenance.ready;
			}),
		),
	);
});

test("ready resolves after the 60s cap when a boot refresh hangs, without blocking the schedule", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const hung = yield* Deferred.make<void>();
				const state = { calls: 0 };
				const index = yield* makePrIndex(() =>
					Effect.gen(function* () {
						yield* Deferred.await(hung);
						return entry;
					}),
				);
				const maintenance = yield* makePrIndexMaintenance(
					Effect.suspend(() => {
						state.calls++;
						return Effect.map(
							index.refresh("root", "acme", "widgets"),
							(fiber) => [fiber],
						);
					}),
					Schedule.recurs(2),
				);
				yield* maintenance.start;
				expect(state.calls).toBe(3);
				const ready = yield* maintenance.ready.pipe(Effect.forkScoped);

				yield* TestClock.adjust("59 seconds");
				expect(yield* isSettled(ready)).toBe(false);
				yield* TestClock.adjust("1 second");
				yield* Fiber.join(ready);
				expect(index.findNumber("acme", "widgets", 3)).toBeUndefined();
			}),
		).pipe(Effect.provide(TestClock.layer())),
	);
});

test("ready resolves as soon as the boot refreshes settle, before the cap", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const index = yield* makePrIndex(() => Effect.succeed(entry));
				const maintenance = yield* makePrIndexMaintenance(
					Effect.map(index.refresh("root", "acme", "widgets"), (fiber) => [
						fiber,
					]),
					Schedule.recurs(0),
				);
				yield* maintenance.start;
				yield* maintenance.ready;
			}),
		).pipe(Effect.provide(TestClock.layer())),
	);
});
