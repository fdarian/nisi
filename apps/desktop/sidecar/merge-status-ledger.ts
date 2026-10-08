import type { PullRequestMergeStatus } from "@repo/sidecar-api";
import { Clock, Context, Effect, Equal, Layer, Ref } from "effect";

export type MergeStatusRecord = {
	readonly status: PullRequestMergeStatus;
	/** When `status` last *changed* — the watch stream dedupes unchanged polls, and a late subscriber is replayed the last value, so neither moves this. */
	readonly changedAt: number;
};

type PullRequestKey = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};

/** Far more PRs than anyone has tabs open for; the cap only stops a long-lived sidecar from growing without bound. */
const MAX_ENTRIES = 200;

const keyOf = (pr: PullRequestKey) => `${pr.owner}/${pr.repo}#${pr.number}`;

/**
 * The last `pullRequests.mergeStatus` value emitted per PR, kept only so
 * `diagnostics.snapshot` can show what the UI was last told. Never read by
 * anything that affects behavior.
 */
export class MergeStatusLedger extends Context.Service<MergeStatusLedger>()(
	"sidecar/merge-status-ledger",
	{
		make: Effect.gen(function* () {
			const entries = yield* Ref.make<ReadonlyMap<string, MergeStatusRecord>>(
				new Map(),
			);
			const record = (pr: PullRequestKey, status: PullRequestMergeStatus) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					yield* Ref.update(entries, (current) => {
						const key = keyOf(pr);
						const previous = current.get(key);
						const changedAt =
							previous !== undefined && Equal.equals(previous.status, status)
								? previous.changedAt
								: now;
						const next = new Map(current);
						// Delete first so re-recording moves the key to the back; the
						// oldest-touched PR is what gets evicted.
						next.delete(key);
						next.set(key, { status, changedAt });
						const oldest = next.keys().next();
						if (next.size > MAX_ENTRIES && oldest.done !== true)
							next.delete(oldest.value);
						return next;
					});
				});
			const get = (pr: PullRequestKey) =>
				Ref.get(entries).pipe(Effect.map((current) => current.get(keyOf(pr))));
			return { record, get };
		}),
	},
) {
	static layer = Layer.effect(MergeStatusLedger, MergeStatusLedger.make);
}
