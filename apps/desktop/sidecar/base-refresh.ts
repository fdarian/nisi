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
			}
		>();
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
						} = { pending };
						state.set(before.key, entry);
						yield* Effect.gen(function* () {
							const result = yield* options.fetch(repoRoot, baseRef);
							entry.result = result;
							const after = yield* options.identity(repoRoot, baseRef);
							if (before.commit !== null && before.commit !== after.commit) {
								yield* options.moved(before.key);
							}
							return result;
						}).pipe(
							Effect.withSpan("session.base-ref.background", { root: true }),
							Effect.onExit((exit) =>
								Effect.gen(function* () {
									entry.completedAt = options.now();
									yield* Deferred.done(pending, exit);
									if (Exit.isFailure(exit))
										yield* Effect.logWarning("Base refresh failed", exit.cause);
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
			stale: (key: string) => state.get(key)?.result?.baseMayBeStale ?? true,
		};
	});
