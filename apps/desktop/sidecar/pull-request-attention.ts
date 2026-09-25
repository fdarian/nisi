import { PullRequestAttention } from "@repo/git";
import type { Session } from "@repo/sidecar-api";
import { Clock, Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

type Entry = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
	readonly watched: boolean;
	readonly awaitingUntil: number | null;
};

const attentionFor = (
	entries: ReadonlyMap<string, Entry>,
	owner: string,
	repo: string,
	number: number,
) => {
	const matching = Array.from(entries.values()).filter(
		(entry) =>
			entry.owner === owner && entry.repo === repo && entry.number === number,
	);
	return {
		watched: matching.some((entry) => entry.watched),
		awaitingNewCi: matching.some((entry) => entry.awaitingUntil !== null),
	};
};

export class AttentionState extends Context.Service<AttentionState>()(
	"sidecar/pull-request-attention",
	{
		make: Effect.gen(function* () {
			const entries = yield* SubscriptionRef.make<ReadonlyMap<string, Entry>>(
				new Map(),
			);
			const set = (session: Session, watched: boolean) =>
				SubscriptionRef.update(entries, (current) => {
					if (session.target.kind !== "pr") {
						if (!current.has(session.id)) return current;
						const next = new Map(current);
						next.delete(session.id);
						return next;
					}
					const next = new Map(current);
					const previous = current.get(session.id);
					next.set(session.id, {
						owner: session.target.owner,
						repo: session.target.repo,
						number: session.target.number,
						watched,
						awaitingUntil:
							previous?.owner === session.target.owner &&
							previous.repo === session.target.repo &&
							previous.number === session.target.number
								? previous.awaitingUntil
								: null,
					});
					return next;
				});
			const remove = (sessionId: string) =>
				SubscriptionRef.update(entries, (current) => {
					if (!current.has(sessionId)) return current;
					const next = new Map(current);
					next.delete(sessionId);
					return next;
				});
			const markChanged = (sessionId: string) =>
				Effect.gen(function* () {
					const deadline = (yield* Clock.currentTimeMillis) + 120_000;
					yield* SubscriptionRef.update(entries, (current) => {
						const entry = current.get(sessionId);
						if (entry === undefined) return current;
						const next = new Map(current);
						next.set(sessionId, { ...entry, awaitingUntil: deadline });
						return next;
					});
					yield* Effect.sleep("120 seconds").pipe(
						Effect.flatMap(() =>
							SubscriptionRef.update(entries, (current) => {
								const entry = current.get(sessionId);
								if (entry === undefined || entry.awaitingUntil !== deadline)
									return current;
								const next = new Map(current);
								next.set(sessionId, { ...entry, awaitingUntil: null });
								return next;
							}),
						),
						Effect.forkDetach,
					);
				});
			const changes = (pr: {
				readonly owner: string;
				readonly repo: string;
				readonly number: number;
			}) =>
				SubscriptionRef.changes(entries).pipe(
					Stream.map((current) =>
						attentionFor(current, pr.owner, pr.repo, pr.number),
					),
					Stream.changesWith(
						(current, previous) =>
							current.watched === previous.watched &&
							current.awaitingNewCi === previous.awaitingNewCi,
					),
				);
			return { changes, set, remove, markChanged };
		}),
	},
) {
	static layer = Layer.effect(AttentionState, AttentionState.make);
}

export const PullRequestAttentionLive = {
	layer: Layer.effect(
		PullRequestAttention,
		Effect.gen(function* () {
			const state = yield* AttentionState;
			return { changes: state.changes };
		}),
	).pipe(Layer.provideMerge(AttentionState.layer)),
};
