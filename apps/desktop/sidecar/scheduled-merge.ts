import {
	GitHub,
	type PullRequestCheck,
	type PullRequestMergeability,
} from "@repo/git";
import {
	RepoMergeMethodStore,
	ScheduledMergeStore,
	type ScheduledMerge,
	type ScheduledMergeKey,
} from "@repo/settings";
import {
	Cause,
	Context,
	Effect,
	Layer,
	Queue,
	Schedule,
	Semaphore,
} from "effect";
import { emit } from "./events.ts";
import { translateMergeFailure } from "./merge-failure.ts";

type MergeDecision =
	| { readonly outcome: "wait" | "merge" }
	| { readonly outcome: "cancelled" | "failed"; readonly reason: string };

export const decideScheduledMerge = (
	status: PullRequestMergeability,
	checks: readonly PullRequestCheck[],
): MergeDecision => {
	if (status.state !== "OPEN")
		return {
			outcome: "cancelled",
			reason: `Pull request ${status.state === "MERGED" ? "merged" : "closed"} elsewhere`,
		};
	const failing = checks.filter((check) => check.status === "failing");
	if (failing.length > 0)
		return {
			outcome: "failed",
			reason: `Checks failed: ${failing.map((check) => check.name).join(", ")}`,
		};
	if (status.mergeStateStatus === "DIRTY")
		return { outcome: "failed", reason: "Merge conflicts" };
	if (
		checks.some(
			(check) =>
				check.status === "pending" ||
				check.status === "running" ||
				check.status === "awaiting_approval",
		) ||
		status.mergeable !== "MERGEABLE" ||
		status.isDraft
	)
		return { outcome: "wait" };
	return status.mergeStateStatus === "CLEAN" ||
		status.mergeStateStatus === "HAS_HOOKS"
		? { outcome: "merge" }
		: { outcome: "wait" };
};

export class ScheduledMerges extends Context.Service<ScheduledMerges>()(
	"sidecar/ScheduledMerges",
	{
		make: Effect.gen(function* () {
			const store = yield* ScheduledMergeStore;
			const preferences = yield* RepoMergeMethodStore;
			const github = yield* GitHub;
			const queue = yield* Queue.unbounded<ScheduledMergeKey>();
			// Serialize checks and mutations so a cancelled or replaced schedule cannot
			// be merged by a stale polling snapshot, or by both polling and an immediate kick.
			const lock = Semaphore.makeUnsafe(1);
			const settle = (
				input: ScheduledMergeKey,
				outcome: "merged" | "failed" | "cancelled",
				reason?: string,
			) =>
				Effect.gen(function* () {
					yield* store.delete(input);
					yield* Effect.sync(() =>
						emit({
							type: "scheduledMergeSettled",
							owner: input.owner,
							repo: input.repo,
							number: input.number,
							outcome,
							...(reason === undefined ? {} : { reason }),
						}),
					);
				});
			const check = (key: ScheduledMergeKey) =>
				lock.withPermit(
					Effect.gen(function* () {
						const input = yield* store.get(key);
						if (input === null) return;
						const status = yield* github.mergeability(
							input.repoRoot,
							input.number,
						);
						if (status.state !== "OPEN") {
							const decision = decideScheduledMerge(status, []);
							if (decision.outcome === "cancelled")
								yield* settle(input, decision.outcome, decision.reason);
							return;
						}
						const checks = yield* github.checks(input);
						const decision = decideScheduledMerge(status, checks);
						if (decision.outcome === "wait") return;
						if (
							decision.outcome === "cancelled" ||
							decision.outcome === "failed"
						) {
							yield* settle(input, decision.outcome, decision.reason);
							return;
						}
						const result = yield* github
							.merge(
								input.repoRoot,
								input.owner,
								input.repo,
								input.number,
								input.method,
							)
							.pipe(
								Effect.map(() => ({ outcome: "merged" as const })),
								Effect.catch((cause) => {
									const failure = translateMergeFailure(cause);
									return Effect.succeed({
										outcome: "failed" as const,
										reason: `${failure.reason}: ${failure.detail}`,
									});
								}),
							);
						if (result.outcome === "failed") {
							yield* settle(input, "failed", result.reason);
							return;
						}
						yield* preferences
							.set(input.owner, input.repo, input.method)
							.pipe(
								Effect.catchTag("SettingsStoreError", (cause) =>
									Effect.logWarning(
										"failed to remember scheduled merge method",
										{ input, cause },
									),
								),
							);
						yield* settle(input, "merged");
					}),
				);
			const recover = <A, E>(effect: Effect.Effect<A, E>) =>
				effect.pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterrupts(cause)
							? Effect.failCause(cause)
							: Effect.logWarning(
									"scheduled merge check failed; retrying next tick",
									{ cause: Cause.pretty(cause) },
								),
					),
				);
			const poll = recover(
				Effect.gen(function* () {
					const schedules = yield* store.list();
					yield* Effect.forEach(schedules, (input) => recover(check(input)), {
						discard: true,
					});
				}),
			);
			const start = () =>
				Effect.gen(function* () {
					yield* poll.pipe(
						Effect.repeat(Schedule.spaced("15 seconds")),
						Effect.forkScoped,
					);
					yield* Effect.gen(function* () {
						const input = yield* Queue.take(queue);
						yield* recover(check(input));
					}).pipe(Effect.repeat(Schedule.forever), Effect.forkScoped);
				});
			const schedule = (input: Omit<ScheduledMerge, "createdAt">) =>
				lock
					.withPermit(store.put(input))
					.pipe(Effect.andThen(Queue.offer(queue, input)), Effect.asVoid);
			const cancel = (key: ScheduledMergeKey) =>
				lock.withPermit(
					Effect.gen(function* () {
						if ((yield* store.get(key)) !== null)
							yield* settle(key, "cancelled", "Auto-merge cancelled by user");
					}),
				);
			return { start, schedule, cancel, check, get: store.get };
		}),
	},
) {
	static layer = Layer.effect(ScheduledMerges, ScheduledMerges.make);
}
