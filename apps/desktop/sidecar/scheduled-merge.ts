import {
	type GitCommandError,
	GitHub,
	type PullRequestCheck,
	type PullRequestMergeability,
	type PullRequestMergeError,
	type PullRequestStackMergeError,
} from "@repo/git";
import {
	RepoMergeMethodStore,
	type ScheduledMerge,
	type ScheduledMergeKey,
	ScheduledMergeStore,
} from "@repo/settings";
import {
	Cause,
	Context,
	Effect,
	Layer,
	Queue,
	Schedule,
	Schema,
	Semaphore,
} from "effect";
import { emit } from "./events.ts";
import { translateMergeFailure } from "./merge-failure.ts";
import { Store } from "./store.ts";

export class AutoMergeAlreadyRan extends Schema.TaggedError<AutoMergeAlreadyRan>()(
	"AutoMergeAlreadyRan",
	{},
) {
	override readonly message = "Auto-merge already ran — the PR was merged";
}

export const isSameSchedule = (
	snapshot: ScheduledMerge,
	current: ScheduledMerge | null,
) =>
	current !== null &&
	current.createdAt.getTime() === snapshot.createdAt.getTime();

export const scheduledMergeHeadMoved = (
	checkedSha: string,
	currentSha: string,
) => checkedSha !== currentSha;

export const isHeadMovedRejection = (detail: string): boolean =>
	/head branch was modified|provided sha does not match head sha|head (?:sha|commit) (?:has )?(?:changed|does not match)/i.test(
		detail,
	);

type MergeAttempt =
	| { readonly outcome: "merged" | "wait" }
	| { readonly outcome: "failed"; readonly reason: string };

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
			// Reads remain cancellable; only final revalidation, merge and settlement
			// are serialized with mutations.
			const lock = Semaphore.makeUnsafe(1);
			const merged = new Set<string>();
			const identity = (key: ScheduledMergeKey) =>
				JSON.stringify([key.owner, key.repo, key.number]);
			const settle = (
				input: ScheduledMergeKey,
				outcome: "merged" | "failed" | "cancelled",
				reason?: string,
			) =>
				Effect.gen(function* () {
					if (outcome === "merged") merged.add(identity(input));
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
			const settleIfCurrent = (
				snapshot: ScheduledMerge,
				outcome: "merged" | "failed" | "cancelled",
				reason?: string,
			) =>
				lock.withPermit(
					Effect.gen(function* () {
						if (isSameSchedule(snapshot, yield* store.get(snapshot)))
							yield* settle(snapshot, outcome, reason);
					}),
				);

			const attemptMerge = (
				input: ScheduledMerge,
				repoRoot: string,
				headRefOid: string,
			) => {
				const merge: (
					...args: Parameters<typeof github.merge>
				) => Effect.Effect<
					void,
					GitCommandError | PullRequestMergeError | PullRequestStackMergeError
				> = input.route === "stack" ? github.mergeStack : github.merge;
				return merge(
					repoRoot,
					input.owner,
					input.repo,
					input.number,
					input.method,
					headRefOid,
				).pipe(
					Effect.map((): MergeAttempt => ({ outcome: "merged" })),
					Effect.catch((cause): Effect.Effect<MergeAttempt> => {
						const failure =
							cause._tag === "GhStackMergeFailed" ||
							cause._tag === "GhOutputDecodeError"
								? {
										reason: "GitHub rejected the merge",
										detail:
											cause._tag === "GhOutputDecodeError"
												? `${cause.raw}: ${String(cause.cause)}`
												: cause.reason,
									}
								: translateMergeFailure(cause);
						return Effect.succeed(
							isHeadMovedRejection(failure.detail)
								? { outcome: "wait" }
								: {
										outcome: "failed",
										reason: `${failure.reason}: ${failure.detail}`,
									},
						);
					}),
				);
			};

			const mergeAndSettleIfCurrent = (
				input: ScheduledMerge,
				repoRoot: string,
				headRefOid: string,
			) =>
				lock.withPermit(
					Effect.gen(function* () {
						if (!isSameSchedule(input, yield* store.get(input)))
							return { outcome: "stale" as const };
						const attempt = yield* attemptMerge(input, repoRoot, headRefOid);
						if (attempt.outcome !== "merged") return attempt;
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
						return attempt;
					}),
				);

			// A push racing a pinned merge is retryable even when GitHub's rejection
			// wording does not identify a head mismatch.
			const rereadHeadMoved = (
				input: ScheduledMerge,
				repoRoot: string,
				checkedSha: string,
			) =>
				github
					.checksSnapshot({ ...input, repoRoot })
					.pipe(
						Effect.map((current) =>
							scheduledMergeHeadMoved(checkedSha, current.headRefOid),
						),
					);

			const check = (key: ScheduledMergeKey) =>
				Effect.gen(function* () {
					const input = yield* store.get(key);
					if (input === null) return;
					const sessions = yield* Store;
					const repoRoot = yield* sessions.resolveScheduledMergeRepoRoot(input);
					if (repoRoot === null) {
						yield* settleIfCurrent(
							input,
							"failed",
							"Worktree was moved or removed",
						);
						return;
					}
					const status = yield* github.mergeability(repoRoot, input.number);
					if (status.state !== "OPEN") {
						const decision = decideScheduledMerge(status, []);
						if (decision.outcome === "cancelled")
							yield* settleIfCurrent(input, decision.outcome, decision.reason);
						return;
					}
					const snapshot = yield* github.checksSnapshot({ ...input, repoRoot });
					const decision = decideScheduledMerge(status, snapshot.checks);
					if (decision.outcome === "wait") return;
					if (
						decision.outcome === "cancelled" ||
						decision.outcome === "failed"
					) {
						yield* settleIfCurrent(input, decision.outcome, decision.reason);
						return;
					}
					const result = yield* mergeAndSettleIfCurrent(
						input,
						repoRoot,
						snapshot.headRefOid,
					);
					if (result.outcome !== "failed") return;
					if (yield* rereadHeadMoved(input, repoRoot, snapshot.headRefOid))
						return;
					yield* settleIfCurrent(input, "failed", result.reason);
				});
			const recover = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
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
					.withPermit(
						store
							.put(input)
							.pipe(
								Effect.tap(() =>
									Effect.sync(() => merged.delete(identity(input))),
								),
							),
					)
					.pipe(Effect.andThen(Queue.offer(queue, input)), Effect.asVoid);
			const cancel = (key: ScheduledMergeKey & { repoRoot: string }) =>
				lock
					.withPermit(
						Effect.gen(function* () {
							if (merged.has(identity(key)))
								return yield* new AutoMergeAlreadyRan({});
							if ((yield* store.get(key)) !== null) {
								yield* settle(key, "cancelled", "Auto-merge cancelled by user");
								return true;
							}
							return false;
						}),
					)
					.pipe(
						Effect.flatMap((cancelled) =>
							Effect.gen(function* () {
								if (cancelled) return;
								const sessions = yield* Store;
								const repoRoot =
									yield* sessions.resolveScheduledMergeRepoRoot(key);
								if (repoRoot === null) return;
								const status = yield* github.mergeability(repoRoot, key.number);
								if (status.state === "MERGED")
									return yield* new AutoMergeAlreadyRan({});
							}),
						),
					);
			return { start, schedule, cancel, check, get: store.get };
		}),
	},
) {
	static layer = Layer.effect(ScheduledMerges, ScheduledMerges.make);
}
