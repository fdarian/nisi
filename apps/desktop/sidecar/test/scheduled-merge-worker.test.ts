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
	Layer,
	Queue,
	Stream,
	type Scope,
} from "effect";
import { type SidecarEvent, subscribe } from "../events.ts";
import { ScheduledMerges } from "../scheduled-merge.ts";

const input = {
	owner: "acme",
	repo: "widgets",
	number: 42,
	repoRoot: "/repo",
	method: "squash" as const,
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
	approveWorkflowRuns: unused,
	overview: unused,
	stack: unused,
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
		ScheduledMerges | ScheduledMergeStore | RepoMergeMethodStore | Scope.Scope
	>,
) => {
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-scheduled-merge-test-"));
	const layer = ScheduledMerges.layer.pipe(
		Layer.provideMerge(
			Layer.mergeAll(
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
