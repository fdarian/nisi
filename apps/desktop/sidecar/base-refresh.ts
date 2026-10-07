import { Deferred, Effect, Exit, Scope } from "effect";

type FetchResult = { baseRef: string; baseMayBeStale: boolean };

export const makeBaseRefresh = <E, R>(options: {
	identity: (
		repoRoot: string,
		baseRef: string,
	) => Effect.Effect<
		{
			key: string;
			commit: string | null;
		},
		E,
		R
	>;
	fetch: (
		repoRoot: string,
		baseRef: string,
	) => Effect.Effect<FetchResult, E, R>;
	moved: (key: string) => Effect.Effect<void, E, R>;
	/** Fires when a fetch settles without the base moving but flips whether the base reads as stale. */
	staleChanged: (key: string) => Effect.Effect<void, E, R>;
	now: () => number;
}) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
		const prepared = new Map<string, { key: string; commit: string | null }>();
		const state = new Map<
			string,
			{
				pending: Deferred.Deferred<FetchResult, E>;
				completedAt?: number;
				result?: FetchResult;
				failed?: boolean;
			}
		>();
		// A fetch that is still running, or one nobody has started, is unknown rather
		// than stale: only a completed fetch that failed proves the base is behind.
		const entryStale = (entry: {
			completedAt?: number;
			result?: FetchResult;
			failed?: boolean;
		}) =>
			entry.completedAt !== undefined &&
			(entry.result?.baseMayBeStale ?? entry.failed === true);
		const isStale = (key: string) => {
			const entry = state.get(key);
			return entry !== undefined && entryStale(entry);
		};
		const refresh = (
			repoRoot: string,
			baseRef: string,
			snapshot?: { key: string; commit: string | null },
		) =>
			Effect.gen(function* () {
				const before =
					snapshot === undefined
						? yield* options.identity(repoRoot, baseRef)
						: snapshot;
				const previous = state.get(before.key);
				if (
					previous !== undefined &&
					(previous.completedAt === undefined ||
						(options.now() - previous.completedAt < 5_000 &&
							previous.result?.baseMayBeStale === false))
				) {
					return previous.pending;
				}
				// Registering the entry and forking its fetch must be atomic: an
				// interruption in between would leave an in-flight entry nothing
				// ever completes, and every later refresh would await it forever.
				return yield* Effect.uninterruptible(
					Effect.gen(function* () {
						const pending = yield* Deferred.make<FetchResult, E>();
						const entry: {
							pending: Deferred.Deferred<FetchResult, E>;
							completedAt?: number;
							result?: FetchResult;
							failed?: boolean;
						} = { pending };
						const staleBefore = isStale(before.key);
						let baseMoved = false;
						state.set(before.key, entry);
						yield* Effect.gen(function* () {
							const result = yield* options.fetch(repoRoot, baseRef);
							entry.result = result;
							const after = yield* options.identity(repoRoot, baseRef);
							if (before.commit !== null && before.commit !== after.commit) {
								baseMoved = true;
								yield* options.moved(before.key);
							}
							return result;
						}).pipe(
							Effect.withSpan("session.base-ref.background", { root: true }),
							Effect.onExit((exit) =>
								Effect.gen(function* () {
									entry.completedAt = options.now();
									entry.failed = Exit.isFailure(exit);
									if (Exit.isFailure(exit))
										yield* Effect.logWarning("Base refresh failed", exit.cause);
									// After `completedAt` is set, so a refetch triggered by this event
									// reads the settled staleness rather than "pending", and before
									// `pending` resolves so a waiter observes the event already out. A moved base
									// already raises the Refresh button; refetching here too would
									// silently swap the file list under it.
									if (!baseMoved && entryStale(entry) !== staleBefore)
										yield* options
											.staleChanged(before.key)
											.pipe(Effect.ignoreCause);
									yield* Deferred.done(pending, exit);
								}),
							),
							Effect.forkIn(scope),
						);
						return pending;
					}),
				);
			});
		return {
			key: (repoRoot: string, baseRef: string) =>
				prepared.get(`${repoRoot}\n${baseRef}`)?.key,
			refresh: (repoRoot: string, baseRef: string) =>
				refresh(repoRoot, baseRef).pipe(Effect.flatMap(Deferred.await)),
			prepare: (repoRoot: string, baseRef: string, restored = false) =>
				Effect.gen(function* () {
					const previous = prepared.get(`${repoRoot}\n${baseRef}`);
					const recent =
						previous === undefined ? undefined : state.get(previous.key);
					if (
						restored &&
						previous !== undefined &&
						previous.commit !== null &&
						recent !== undefined &&
						(recent.completedAt === undefined ||
							options.now() - recent.completedAt < 5_000)
					)
						return;
					const local = yield* options.identity(repoRoot, baseRef);
					prepared.set(`${repoRoot}\n${baseRef}`, local);
					if (local.commit === null)
						yield* refresh(repoRoot, baseRef, local).pipe(
							Effect.flatMap(Deferred.await),
						);
				}),
			background: (repoRoot: string, baseRef: string) =>
				Effect.gen(function* () {
					const previous = prepared.get(`${repoRoot}\n${baseRef}`);
					const local =
						previous === undefined
							? yield* options.identity(repoRoot, baseRef)
							: previous;
					yield* refresh(repoRoot, baseRef, local);
				}),
			stale: isStale,
		};
	});
