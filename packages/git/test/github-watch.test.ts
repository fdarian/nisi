import { describe, expect, test } from "bun:test";
import {
	Duration,
	Effect,
	Fiber,
	PubSub,
	Ref,
	Result,
	Stream,
	SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { GhNotAuthenticated, GhRateLimited } from "../src/errors.ts";
import {
	checksInterval,
	kick,
	makeWatch,
	mergeStatusInterval,
	overviewInterval,
	stackInterval,
	watchFromMap,
} from "../src/github/gh/watch.ts";

const pr = { repoRoot: "/repo", owner: "acme", repo: "widgets", number: 42 };

const run = (program: Effect.Effect<void, never, TestClock.TestClock>) =>
	Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())));
const settle = Effect.forEach(
	Array.from({ length: 20 }),
	() => Effect.yieldNow,
);

describe("gh watch polling", () => {
	test("uses the settled, unsettled, and paused resource cadences", () => {
		const watched = { watched: true, awaitingNewCi: false };
		const hidden = { watched: false, awaitingNewCi: false };
		const milliseconds = (value: Duration.Input | null) =>
			value === null ? null : Duration.toMillis(value);
		expect(milliseconds(checksInterval([], watched))).toBe(60_000);
		expect(milliseconds(checksInterval([], hidden))).toBeNull();
		expect(
			milliseconds(checksInterval([], { watched: true, awaitingNewCi: true })),
		).toBe(10_000);
		expect(
			milliseconds(checksInterval([{ name: "CI", status: "running" }], hidden)),
		).toBe(10_000);
		const mergeability = {
			state: "OPEN" as const,
			mergeable: "UNKNOWN" as const,
			mergeStateStatus: "UNKNOWN" as const,
			isDraft: false,
		};
		expect(
			milliseconds(
				mergeStatusInterval(
					{ mergeability, allowedMethods: ["merge"] },
					hidden,
				),
			),
		).toBe(2_000);
		expect(
			milliseconds(
				mergeStatusInterval(
					{
						mergeability: { ...mergeability, mergeable: "MERGEABLE" },
						allowedMethods: ["merge"],
					},
					watched,
				),
			),
		).toBe(10_000);
		expect(
			mergeStatusInterval(
				{
					mergeability: { ...mergeability, state: "MERGED" },
					allowedMethods: ["merge"],
				},
				watched,
			),
		).toBeNull();
		expect(milliseconds(stackInterval(null, watched))).toBe(60_000);
		expect(stackInterval(null, hidden)).toBeNull();
		expect(
			milliseconds(
				overviewInterval(
					{
						description: { authorLogin: "alice", body: null },
						commits: [
							{
								sha: "a",
								shortSha: "a",
								headline: "a",
								body: null,
								authorName: "Alice",
								authorLogin: "alice",
								committedDate: "2026-01-01",
								url: null,
								checks: [{ name: "CI", status: "pending" }],
							},
						],
					},
					hidden,
				),
			),
		).toBe(10_000);
	});
	test("shares an upstream, replays latest, dedupes, and follows attention cadence", async () => {
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const attention = yield* SubscriptionRef.make({
						watched: true,
						awaitingNewCi: false,
					});
					const kicks = yield* PubSub.unbounded<string>();
					const reads = yield* Ref.make(0);
					const values: number[] = [];
					const late: number[] = [];
					const map = yield* makeWatch(
						{ changes: () => SubscriptionRef.changes(attention) },
						kicks,
						() =>
							Ref.updateAndGet(reads, (count) => count + 1).pipe(
								Effect.map(() => 1),
							),
						(_value, current) =>
							current.watched ? Duration.seconds(10) : null,
					);
					const first = yield* Stream.runForEach(
						watchFromMap(map, pr),
						(value) =>
							Effect.sync(() => {
								values.push(value);
							}),
					).pipe(Effect.forkScoped);
					yield* settle;
					yield* TestClock.adjust("1 millis");
					expect(values).toEqual([1]);
					const second = yield* Stream.runForEach(
						watchFromMap(map, pr),
						(value) =>
							Effect.sync(() => {
								late.push(value);
							}),
					).pipe(Effect.forkScoped);
					yield* settle;
					yield* TestClock.adjust("1 millis");
					expect(late).toEqual([1]);
					expect(yield* Ref.get(reads)).toBe(1);
					yield* TestClock.adjust("10 seconds");
					expect(yield* Ref.get(reads)).toBe(2);
					expect(values).toEqual([1]);
					yield* SubscriptionRef.set(attention, {
						watched: false,
						awaitingNewCi: false,
					});
					yield* TestClock.adjust("1 millis");
					expect(yield* Ref.get(reads)).toBe(3);
					yield* TestClock.adjust("1 minute");
					expect(yield* Ref.get(reads)).toBe(3);
					yield* kick(kicks, pr);
					yield* TestClock.adjust("1 millis");
					expect(yield* Ref.get(reads)).toBe(4);
					yield* Fiber.interrupt(first);
					yield* Fiber.interrupt(second);
				}),
			).pipe(Effect.asVoid),
		);
	});
	test("backs off after a rate limit and fails on authentication", async () => {
		await run(
			Effect.scoped(
				Effect.gen(function* () {
					const kicks = yield* PubSub.unbounded<string>();
					const attempts = yield* Ref.make(0);
					const map = yield* makeWatch(
						{
							changes: () =>
								Stream.succeed({ watched: true, awaitingNewCi: false }),
						},
						kicks,
						() =>
							Ref.updateAndGet(attempts, (count) => count + 1).pipe(
								Effect.flatMap((count) =>
									Effect.fail<GhRateLimited | GhNotAuthenticated>(
										count === 1
											? new GhRateLimited({ reason: "rate limit" })
											: new GhNotAuthenticated({ reason: "signed out" }),
									),
								),
							),
						() => Duration.seconds(10),
					);
					const result = yield* Effect.result(
						Stream.runHead(watchFromMap(map, pr)),
					).pipe(Effect.forkScoped);
					yield* settle;
					yield* TestClock.adjust("1 millis");
					expect(yield* Ref.get(attempts)).toBe(1);
					yield* TestClock.adjust("999 millis");
					expect(yield* Ref.get(attempts)).toBe(2);
					const outcome = yield* Fiber.join(result);
					expect(Result.isFailure(outcome)).toBe(true);
					if (Result.isFailure(outcome))
						expect(outcome.failure._tag).toBe("GhNotAuthenticated");
				}),
			).pipe(Effect.asVoid),
		);
	});
});
