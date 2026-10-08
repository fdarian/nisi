import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/server";
import { RepoPathNotFound } from "@repo/git";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { errorTagOf, RpcFailureLedger } from "../rpc-failure-ledger.ts";

const run = <A, E>(effect: Effect.Effect<A, E, RpcFailureLedger>) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(RpcFailureLedger.layer),
			Effect.provide(TestClock.layer()),
		),
	);

test("errorTagOf prefers _tag, then ORPCError code, then the error name", () => {
	expect(errorTagOf(new RepoPathNotFound({ path: "/gone" }))).toBe(
		"RepoPathNotFound",
	);
	expect(errorTagOf(new ORPCError("SERVICE_UNAVAILABLE"))).toBe(
		"SERVICE_UNAVAILABLE",
	);
	expect(errorTagOf(new TypeError("boom"))).toBe("TypeError");
	expect(errorTagOf("boom")).toBe("string");
});

test("groups repeats by path and error tag", () =>
	run(
		Effect.gen(function* () {
			const ledger = yield* RpcFailureLedger;
			yield* ledger.record(
				["sessions", "setAttention"],
				new RepoPathNotFound({ path: "/gone" }),
			);
			yield* TestClock.adjust("3 seconds");
			yield* ledger.record(
				["sessions", "setAttention"],
				new RepoPathNotFound({ path: "/gone-too" }),
			);
			yield* ledger.record(["sessions", "list"], new Error("other"));
			const failures = yield* ledger.list;
			expect(failures).toHaveLength(2);
			const grouped = failures.find(
				(failure) => failure.path === "sessions.setAttention",
			);
			expect(grouped).toMatchObject({
				errorTag: "RepoPathNotFound",
				count: 2,
				firstAt: 0,
				lastAt: 3_000,
			});
			expect(grouped?.lastMessage).toContain("/gone-too");
		}),
	));

test("the same path under a different tag is a separate entry", () =>
	run(
		Effect.gen(function* () {
			const ledger = yield* RpcFailureLedger;
			yield* ledger.record(["a", "b"], new TypeError("x"));
			yield* ledger.record(["a", "b"], new RangeError("x"));
			expect(yield* ledger.list).toHaveLength(2);
		}),
	));

test("truncates long messages and evicts the oldest entry past the cap", () =>
	run(
		Effect.gen(function* () {
			const ledger = yield* RpcFailureLedger;
			yield* ledger.record(["first"], new Error("x".repeat(10_000)));
			expect((yield* ledger.list)[0]?.lastMessage).toHaveLength(500);
			for (let index = 0; index < 100; index++)
				yield* ledger.record([`path${index}`], new Error("x"));
			const failures = yield* ledger.list;
			expect(failures).toHaveLength(100);
			expect(failures.some((failure) => failure.path === "first")).toBe(false);
		}),
	));
