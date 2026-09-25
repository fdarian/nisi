import {
	Duration,
	Effect,
	Equal,
	Hash,
	Option,
	PubSub,
	RcMap,
	Ref,
	Schedule,
	Stream,
} from "effect";
import type { Attention, PullRequestIdentity } from "./attention.ts";
import type { PullRequestAttention } from "./attention.ts";
import type {
	PullRequestCheck,
	PullRequestMergeStatus,
	PullRequestOverview,
} from "../models.ts";

type Key = PullRequestIdentity & { readonly repoRoot: string };
type WatchState = { readonly delay: Duration.Input | null };

class WatchKey implements Key, Equal.Equal {
	readonly repoRoot: string;
	readonly owner: string;
	readonly repo: string;
	readonly number: number;

	constructor(input: Key) {
		this.repoRoot = input.repoRoot;
		this.owner = input.owner;
		this.repo = input.repo;
		this.number = input.number;
	}

	[Equal.symbol](that: Equal.Equal): boolean {
		return (
			that instanceof WatchKey &&
			this.owner === that.owner &&
			this.repo === that.repo &&
			this.number === that.number
		);
	}

	[Hash.symbol](): number {
		return Hash.structureKeys(this, ["owner", "repo", "number"]);
	}
}

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
}) =>
	error._tag === "GhRateLimited" ||
	((error._tag === "GitHubUnreachable" ||
		error._tag === "PullRequestNotFound") &&
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
		lookup: (key: WatchKey) =>
			Effect.gen(function* () {
				const latest = yield* Ref.make<Attention | undefined>(undefined);
				const lastValue = yield* Ref.make<Option.Option<A>>(Option.none());
				const attentionChanges = attention.changes(key).pipe(
					Stream.mapEffect((value) =>
						Ref.getAndSet(latest, value).pipe(
							Effect.map((previous) => ({
								attention: value,
								immediate:
									previous === undefined ||
									(!previous.watched && value.watched) ||
									(!previous.awaitingNewCi && value.awaitingNewCi),
							})),
						),
					),
				);
				const refreshes = Stream.fromPubSub(kicks).pipe(
					Stream.filter((pr) => pr === identity(key)),
					Stream.mapEffect(() => Ref.get(latest)),
					Stream.filter((value): value is Attention => value !== undefined),
					Stream.map((value) => ({ attention: value, immediate: true })),
				);
				const pollFor = (trigger: {
					readonly attention: Attention;
					readonly immediate: boolean;
				}) =>
					Stream.unwrap(
						Effect.gen(function* () {
							const previous = yield* Ref.get(lastValue);
							const initialDelay =
								trigger.immediate || Option.isNone(previous)
									? Duration.zero
									: interval(previous.value, trigger.attention);
							return Stream.unfold(
								{ delay: initialDelay },
								(state: WatchState) =>
									Effect.gen(function* () {
										if (state.delay === null) return yield* Effect.never;
										yield* Effect.sleep(state.delay);
										const value = yield* read(key).pipe(
											Effect.retry({
												schedule: retrySchedule,
												while: isTransient,
											}),
										);
										yield* Ref.set(lastValue, Option.some(value));
										return [
											value,
											{ delay: interval(value, trigger.attention) },
										] as const;
									}),
							);
						}),
					);
				const source = Stream.merge(attentionChanges, refreshes).pipe(
					Stream.switchMap(pollFor),
					Stream.changesWith((current, previous) =>
						Equal.equals(current, previous),
					),
				);
				return yield* Stream.share(source, {
					capacity: 16,
					strategy: "sliding",
					replay: 1,
				});
			}),
	});

export const kick = (
	kicks: PubSub.PubSub<string>,
	input: PullRequestIdentity,
) => PubSub.publish(kicks, identity(input));

export const watchFromMap = <A, E>(
	map: RcMap.RcMap<WatchKey, Stream.Stream<A, E>>,
	input: Key,
) => Stream.scoped(Stream.unwrap(RcMap.get(map, new WatchKey(input))));
