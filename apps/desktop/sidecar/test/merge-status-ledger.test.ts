import { expect, test } from "bun:test";
import type { PullRequestMergeStatus } from "@repo/sidecar-api";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { MergeStatusLedger } from "../merge-status-ledger.ts";

const status = (
	mergeable: PullRequestMergeStatus["mergeable"],
): PullRequestMergeStatus => ({
	state: "OPEN",
	mergeable,
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["squash"],
	defaultMethod: "squash",
});

const pr = (number: number) => ({ owner: "acme", repo: "widgets", number });

const run = <A, E>(effect: Effect.Effect<A, E, MergeStatusLedger>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(MergeStatusLedger.layer),
			Effect.provide(TestClock.layer()),
		),
	);

test("records the last emitted status per PR", () =>
	run(
		Effect.gen(function* () {
			const ledger = yield* MergeStatusLedger;
			expect(yield* ledger.get(pr(1))).toBeUndefined();
			yield* ledger.record(pr(1), status("UNKNOWN"));
			yield* ledger.record(pr(2), status("CONFLICTING"));
			yield* ledger.record(pr(1), status("MERGEABLE"));
			expect((yield* ledger.get(pr(1)))?.status.mergeable).toBe("MERGEABLE");
			expect((yield* ledger.get(pr(2)))?.status.mergeable).toBe("CONFLICTING");
		}),
	));

test("changedAt only moves when the status changes", () =>
	run(
		Effect.gen(function* () {
			const ledger = yield* MergeStatusLedger;
			yield* ledger.record(pr(1), status("MERGEABLE"));
			yield* TestClock.adjust("5 seconds");
			// A late subscriber is replayed the same value; that must not look fresh.
			yield* ledger.record(pr(1), status("MERGEABLE"));
			expect((yield* ledger.get(pr(1)))?.changedAt).toBe(0);
			yield* TestClock.adjust("5 seconds");
			yield* ledger.record(pr(1), status("CONFLICTING"));
			expect((yield* ledger.get(pr(1)))?.changedAt).toBe(10_000);
		}),
	));

test("evicts the least recently recorded PR past the cap", () =>
	run(
		Effect.gen(function* () {
			const ledger = yield* MergeStatusLedger;
			for (let number = 1; number <= 201; number++)
				yield* ledger.record(pr(number), status("MERGEABLE"));
			expect(yield* ledger.get(pr(1))).toBeUndefined();
			expect(yield* ledger.get(pr(2))).toBeDefined();
			expect(yield* ledger.get(pr(201))).toBeDefined();
		}),
	));
