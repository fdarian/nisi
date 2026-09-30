import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import {
	GhMergeFailed,
	GhRateLimited,
	GitHub,
	type GitHubShape,
	type PullRequestMergeability,
} from "@repo/git";
import { RepoMergeMethodStore, ScheduledMergeStore } from "@repo/settings";
import {
	ConfigProvider,
	Effect,
	Fiber,
	Exit,
	Layer,
	Queue,
	type Scope,
	Stream,
} from "effect";
import { type SidecarEvent, subscribe } from "../events.ts";
import { AutoMergeAlreadyRan, ScheduledMerges } from "../scheduled-merge.ts";
import { Store } from "../store.ts";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";

const input = {
	owner: "acme",
	repo: "widgets",
	number: 42,
	repoRoot: process.cwd(),
	method: "squash" as const,
	route: "merge" as const,
};
const clean: PullRequestMergeability = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
};
const unused = () => Effect.die(new Error("unused mock GitHub method"));
const unusedStream = () => Stream.die(new Error("unused mock GitHub method"));
const mockGitHub = (overrides: Partial<GitHubShape>): GitHubShape => ({
	repository: unused,
	pullRequest: unused,
	headRef: unused,
	search: unused,
	checks: () => Effect.succeed([{ name: "Tests", status: "passing" }]),
	checksSnapshot: () =>
		Effect.succeed({
			headRefOid: "checked-head",
			checks: [{ name: "Tests", status: "passing" }],
		}),
	approveWorkflowRuns: unused,
	overview: unused,
	stack: () => Effect.succeed(null),
	mergeability: () => Effect.succeed(clean),
	mergeMethods: unused,
	merge: () => Effect.void,
	mergeStack: unused,
	markReady: unused,
	watchChecks: unusedStream,
	watchMergeStatus: unusedStream,
	watchStack: unusedStream,
	watchOverview: unusedStream,
	...overrides,
});

const run = async <A, E>(
	overrides: Partial<GitHubShape>,
	program: Effect.Effect<
		A,
		E,
		| ScheduledMerges
		| ScheduledMergeStore
		| RepoMergeMethodStore
		| Scope.Scope
		| Store
		| FileSystem
		| ChildProcessSpawner.ChildProcessSpawner
	>,
) => {
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-scheduled-merge-test-"));
	const layer = ScheduledMerges.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				Store.layer,
				ScheduledMergeStore.layer,
				RepoMergeMethodStore.layer,
				Layer.succeed(GitHub, mockGitHub(overrides)),
			),
		),
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);
	try {
		return await Effect.runPromise(
			program.pipe(Effect.provide(layer), Effect.scoped),
		);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
};

const eventQueue = Effect.gen(function* () {
	const events = yield* Queue.unbounded<SidecarEvent>();
	yield* Effect.acquireRelease(
		Effect.sync(() =>
			subscribe((event) => {
				if (event.type === "scheduledMergeSettled")
					Queue.offerUnsafe(events, event);
			}),
		),
		(unsubscribe) => Effect.sync(unsubscribe),
	);
	return events;
});

describe("scheduled merge worker", () => {
	test("cancel wins while GitHub reads are in flight", async () => {
		const entered = await Effect.runPromise(Queue.unbounded<void>());
		const resume = await Effect.runPromise(Queue.unbounded<void>());
		const merges: number[] = [];
		await run(
			{
				mergeability: () =>
					Queue.offer(entered, undefined).pipe(
						Effect.andThen(Queue.take(resume)),
						Effect.as(clean),
					),
				merge: () =>
					Effect.sync(() => {
						merges.push(42);
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				const check = yield* worker.check(input).pipe(Effect.forkScoped);
				yield* Queue.take(entered);
				yield* worker.cancel(input).pipe(Effect.timeout("2 seconds"));
				yield* Queue.offer(resume, undefined);
				yield* Fiber.join(check);
				expect(merges).toHaveLength(0);
				expect(yield* worker.get(input)).toBeNull();
			}),
		);
	});
	test("replacement invalidates the in-flight snapshot even for the same method", async () => {
		const entered = await Effect.runPromise(Queue.unbounded<void>());
		const resume = await Effect.runPromise(Queue.unbounded<void>());
		const merges: number[] = [];
		await run(
			{
				mergeability: () =>
					Queue.offer(entered, undefined).pipe(
						Effect.andThen(Queue.take(resume)),
						Effect.as(clean),
					),
				merge: () =>
					Effect.sync(() => {
						merges.push(42);
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				const original = yield* worker.get(input);
				const check = yield* worker.check(input).pipe(Effect.forkScoped);
				yield* Queue.take(entered);
				yield* worker.schedule(input).pipe(Effect.timeout("2 seconds"));
				yield* Queue.offer(resume, undefined);
				yield* Fiber.join(check);
				expect(merges).toHaveLength(0);
				expect((yield* worker.get(input))?.createdAt.getTime()).not.toBe(
					original?.createdAt.getTime(),
				);
			}),
		);
	});
	test("cancel queued behind a merge returns the defined conflict", async () => {
		const entered = await Effect.runPromise(Queue.unbounded<void>());
		const resume = await Effect.runPromise(Queue.unbounded<void>());
		await run(
			{
				merge: () =>
					Queue.offer(entered, undefined).pipe(
						Effect.andThen(Queue.take(resume)),
						Effect.asVoid,
					),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				const check = yield* worker.check(input).pipe(Effect.forkScoped);
				yield* Queue.take(entered);
				const cancellation = yield* worker
					.cancel(input)
					.pipe(Effect.exit, Effect.forkScoped);
				yield* Queue.offer(resume, undefined);
				yield* Fiber.join(check);
				const result = yield* Fiber.join(cancellation);
				expect(Exit.isFailure(result)).toBe(true);
				expect(
					yield* worker
						.cancel(input)
						.pipe(
							Effect.catchTag("AutoMergeAlreadyRan", (error) =>
								Effect.succeed(error.message),
							),
						),
				).toBe(new AutoMergeAlreadyRan({}).message);
			}),
		);
	});
	test("head moved rejects the pinned attempt but waits and retries with the new SHA", async () => {
		const state = {
			sha: "checked-head",
			attempts: [] as (string | undefined)[],
		};
		await run(
			{
				checksSnapshot: () =>
					Effect.succeed({
						headRefOid: state.sha,
						checks: [{ name: "Tests", status: "passing" }],
					}),
				merge: (_root, _owner, _repo, _number, _method, sha) =>
					Effect.gen(function* () {
						state.attempts.push(sha);
						if (sha === "checked-head") {
							state.sha = "new-head";
							return yield* new GhMergeFailed({
								repoRoot: input.repoRoot,
								number: 42,
								reason: "Merge rejected by GitHub",
							});
						}
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				yield* worker.check(input);
				expect((yield* worker.get(input))?.method).toBe("squash");
				yield* worker.check(input);
				expect(yield* worker.get(input)).toBeNull();
				expect(state.attempts).toEqual(["checked-head", "new-head"]);
			}),
		);
	});
	test("explicit head-mismatch rejection waits even if the next read is stale", async () => {
		await run(
			{
				merge: () =>
					new GhMergeFailed({
						repoRoot: input.repoRoot,
						number: 42,
						reason: "Head branch was modified. Review and try the merge again.",
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				yield* worker.check(input);
				expect((yield* worker.get(input))?.method).toBe("squash");
			}),
		);
	});
	test("native stack members use mergeStack with the checked SHA", async () => {
		const calls: (string | undefined)[] = [];
		await run(
			{
				merge: unused,
				mergeStack: (_root, _owner, _repo, _number, _method, sha) =>
					Effect.sync(() => {
						calls.push(sha);
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule({ ...input, route: "stack" });
				yield* worker.check(input);
				expect(calls).toEqual(["checked-head"]);
			}),
		);
	});
	test("missing worktree settles as failed instead of retrying gh", async () => {
		await run(
			{ mergeability: unused },
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				const events = yield* eventQueue;
				const missing = {
					...input,
					repoRoot: `${input.repoRoot}/missing-${crypto.randomUUID()}`,
				};
				yield* worker.schedule(missing);
				yield* worker.check(missing);
				const event = yield* Queue.take(events);
				expect(
					event.type === "scheduledMergeSettled" &&
						event.outcome === "failed" &&
						event.reason,
				).toBe("Worktree was moved or removed");
				expect(yield* worker.get(input)).toBeNull();
			}),
		);
	});
	test("checks immediately, remembers method, deletes, and emits merged", async () => {
		const merges: string[] = [];
		await run(
			{
				merge: (_root, _owner, _repo, _number, method) =>
					Effect.sync(() => {
						merges.push(method);
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				const preferences = yield* RepoMergeMethodStore;
				const events = yield* eventQueue;
				yield* worker.start();
				yield* worker.schedule(input);
				const event = yield* Queue.take(events).pipe(
					Effect.timeout("2 seconds"),
				);
				expect(
					event.type === "scheduledMergeSettled" && event.outcome === "merged",
				).toBe(true);
				expect(yield* worker.get(input)).toBeNull();
				expect(yield* preferences.get(input.owner, input.repo)).toBe("squash");
				expect(merges).toEqual(["squash"]);
			}),
		);
	});
	test("polling and kicks cannot merge the same schedule twice", async () => {
		const merges: number[] = [];
		await run(
			{
				merge: (_root, _owner, _repo, number) =>
					Effect.sync(() => {
						merges.push(number);
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				yield* Effect.all([worker.check(input), worker.check(input)], {
					concurrency: "unbounded",
				});
				expect(merges).toEqual([42]);
			}),
		);
	});
	test("cancelled snapshots cannot merge; replacement uses latest method", async () => {
		const merges: string[] = [];
		await run(
			{
				merge: (_root, _owner, _repo, _number, method) =>
					Effect.sync(() => {
						merges.push(method);
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				yield* worker.schedule(input);
				yield* worker.cancel(input);
				yield* worker.check(input);
				expect(merges).toHaveLength(0);
				yield* worker.schedule(input);
				yield* worker.schedule({ ...input, method: "rebase" });
				yield* worker.check(input);
				expect(merges).toEqual(["rebase"]);
			}),
		);
	});
	test("merge rejection is translated, removed, and emitted as failed", async () => {
		await run(
			{
				merge: () =>
					new GhMergeFailed({
						repoRoot: input.repoRoot,
						number: input.number,
						reason: "Required review missing",
					}),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				const events = yield* eventQueue;
				yield* worker.schedule(input);
				yield* worker.check(input);
				const event = yield* Queue.take(events);
				expect(
					event.type === "scheduledMergeSettled" &&
						event.outcome === "failed" &&
						event.reason?.includes("Required review missing"),
				).toBe(true);
				expect(yield* worker.get(input)).toBeNull();
			}),
		);
	});
	test("a failed fetch retains its schedule without killing immediate checks", async () => {
		await run(
			{
				mergeability: (_root, number) =>
					number === 42
						? new GhRateLimited({ reason: "Try later" })
						: Effect.succeed(clean),
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				const events = yield* eventQueue;
				yield* worker.start();
				yield* worker.schedule(input);
				yield* worker.schedule({ ...input, number: 43 });
				const event = yield* Queue.take(events).pipe(
					Effect.timeout("2 seconds"),
				);
				expect(
					event.type === "scheduledMergeSettled" &&
						event.number === 43 &&
						event.outcome === "merged",
				).toBe(true);
				expect((yield* worker.get(input))?.method).toBe("squash");
			}),
		);
	});
	test("closed PRs cancel without requiring CI fetch", async () => {
		await run(
			{
				mergeability: () => Effect.succeed({ ...clean, state: "CLOSED" }),
				checks: unused,
			},
			Effect.gen(function* () {
				const worker = yield* ScheduledMerges;
				const events = yield* eventQueue;
				yield* worker.schedule(input);
				yield* worker.check(input);
				const event = yield* Queue.take(events);
				expect(
					event.type === "scheduledMergeSettled" &&
						event.outcome === "cancelled",
				).toBe(true);
				expect(yield* worker.get(input)).toBeNull();
			}),
		);
	});
});
