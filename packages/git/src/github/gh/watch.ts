import { Duration, Effect, PubSub, RcMap, Ref, Schedule, Stream } from "effect";
import type { Attention, PullRequestIdentity } from "./attention.ts";
import type { PullRequestAttention } from "./attention.ts";
import type {
	PullRequestCheck,
	PullRequestMergeStatus,
	PullRequestOverview,
} from "../models.ts";

type Key = PullRequestIdentity & { readonly repoRoot: string };
type WatchState = { readonly delay: Duration.Input | null };

export const checksInterval = (
	value: ReadonlyArray<PullRequestCheck>,
	current: Attention,
) =>
	value.some(
		(check) => check.status === "running" || check.status === "pending",
	) ||
	(current.watched && current.awaitingNewCi)
		? Duration.seconds(10)
		: current.watched
			? Duration.seconds(60)
			: null;

export const mergeStatusInterval = (
	value: PullRequestMergeStatus,
	current: Attention,
) =>
	value.mergeability.state !== "OPEN"
		? null
		: value.mergeability.mergeable === "UNKNOWN"
			? Duration.seconds(2)
			: current.watched
				? Duration.seconds(10)
				: null;

export const stackInterval = (_value: unknown, current: Attention) =>
	current.watched ? Duration.seconds(60) : null;

export const overviewInterval = (
	value: PullRequestOverview,
	current: Attention,
) =>
	value.commits.some(
		(commit) =>
			commit.checks?.some(
				(check) => check.status === "running" || check.status === "pending",
			) === true,
	)
		? Duration.seconds(10)
		: current.watched
			? Duration.seconds(60)
			: null;

const identity = (key: PullRequestIdentity) =>
	`${key.owner}/${key.repo}#${key.number}`;

const retrySchedule = Schedule.exponential("1 second").pipe(
	Schedule.modifyDelay((metadata) =>
		Effect.succeed(Duration.min(metadata.duration, Duration.minutes(5))),
	),
);

const isTransient = (error: {
	readonly _tag: string;
	readonly reason?: string;
	readonly exitCode?: number | null;
}) =>
	error._tag === "GhRateLimited" ||
	(error._tag === "GitCommandError" && error.exitCode !== null) ||
	error._tag === "GitHubUnreachable" ||
	(error._tag === "PullRequestNotFound" &&
		error.reason !== undefined &&
		/connection refused|could not resolve host|no such host|dial tcp|timeout|TLS handshake|network is unreachable|connection reset|HTTP 50[0234]/i.test(
			error.reason,
		));

export const makeWatch = <A, E extends { readonly _tag: string }>(
	attention: PullRequestAttention["Service"],
	kicks: PubSub.PubSub<string>,
	read: (key: Key) => Effect.Effect<A, E>,
	interval: (value: A, attention: Attention) => Duration.Input | null,
) =>
	RcMap.make({
		idleTimeToLive: "10 seconds",
		lookup: (key: Key) =>
			Effect.gen(function* () {
				const latest = yield* Ref.make<Attention | undefined>(undefined);
				const attentionChanges = attention
					.changes(key)
					.pipe(Stream.tap((value) => Ref.set(latest, value)));
				const refreshes = Stream.fromPubSub(kicks).pipe(
					Stream.filter((pr) => pr === identity(key)),
					Stream.mapEffect(() => Ref.get(latest)),
					Stream.filter((value): value is Attention => value !== undefined),
				);
				const source = Stream.merge(attentionChanges, refreshes).pipe(
					Stream.switchMap((current) =>
						Stream.unfold({ delay: Duration.zero }, (state: WatchState) =>
							Effect.gen(function* () {
								if (state.delay === null) return yield* Effect.never;
								yield* Effect.sleep(state.delay);
								const value = yield* read(key).pipe(
									Effect.retry({
										schedule: retrySchedule,
										while: isTransient,
									}),
								);
								return [value, { delay: interval(value, current) }] as const;
							}),
						),
					),
					Stream.changesWith(
						(current, previous) =>
							JSON.stringify(current) === JSON.stringify(previous),
					),
				);
				return yield* Stream.share(source, {
					capacity: 16,
					strategy: "sliding",
					replay: 1,
				});
			}),
	});

export const watchKey = (input: Key) => ({ ...input });
export const kick = (
	kicks: PubSub.PubSub<string>,
	input: PullRequestIdentity,
) => PubSub.publish(kicks, identity(input));

export const watchFromMap = <A, E>(
	map: RcMap.RcMap<Key, Stream.Stream<A, E>>,
	input: Key,
) => Stream.scoped(Stream.unwrap(RcMap.get(map, watchKey(input))));
