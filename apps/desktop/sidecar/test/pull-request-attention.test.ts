import { expect, test } from "bun:test";
import { PullRequestAttention } from "@repo/git";
import type { Session } from "@repo/sidecar-api";
import { Effect, Option, Stream } from "effect";
import { TestClock } from "effect/testing";
import {
	AttentionState,
	PullRequestAttentionLive,
} from "../pull-request-attention.ts";

const session = (id: string): Session => ({
	id,
	repoRoot: "/repo",
	target: {
		kind: "pr",
		number: 42,
		owner: "acme",
		repo: "widgets",
		title: "Feature",
		baseRef: "main",
		headRef: "feature",
	},
});

test("attention combines PR sessions and expires the local-change window", async () => {
	await Effect.runPromise(
		Effect.gen(function* () {
			const state = yield* AttentionState;
			const attention = yield* PullRequestAttention;
			const current = () =>
				Stream.runHead(
					attention.changes({ owner: "acme", repo: "widgets", number: 42 }),
				).pipe(Effect.map(Option.getOrThrow));
			yield* state.set(session("first"), true);
			yield* state.set(session("second"), false);
			expect(yield* current()).toEqual({ watched: true, awaitingNewCi: false });
			yield* state.markChanged("second");
			expect(yield* current()).toEqual({ watched: true, awaitingNewCi: true });
			yield* state.remove("first");
			expect(yield* current()).toEqual({ watched: false, awaitingNewCi: true });
			yield* TestClock.adjust("120 seconds");
			expect(yield* current()).toEqual({
				watched: false,
				awaitingNewCi: false,
			});
		}).pipe(
			Effect.provide(PullRequestAttentionLive.layer),
			Effect.provide(TestClock.layer()),
		),
	);
});
