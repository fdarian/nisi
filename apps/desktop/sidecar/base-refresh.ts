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
		const state = new Map<
			string,
			{
				pending: Deferred.Deferred<FetchResult, E>;
				completedAt?: number;
				result?: FetchResult;
			}
		>();
		const refresh = (repoRoot: string, baseRef: string) =>
			Effect.gen(function* () {
				const before = yield* options.identity(repoRoot, baseRef);
				const previous = state.get(before.key);
				if (
					previous !== undefined &&
					(previous.completedAt === undefined ||
						(options.now() - previous.completedAt < 5_000 &&
							previous.result?.baseMayBeStale === false))
				) {
					return previous.pending;
				}
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
			});
		return {
			refresh: (repoRoot: string, baseRef: string) =>
				refresh(repoRoot, baseRef).pipe(Effect.flatMap(Deferred.await)),
			prepare: (repoRoot: string, baseRef: string) =>
				Effect.gen(function* () {
					const local = yield* options.identity(repoRoot, baseRef);
					if (local.commit === null)
						yield* refresh(repoRoot, baseRef).pipe(
							Effect.flatMap(Deferred.await),
						);
				}),
			background: (repoRoot: string, baseRef: string) =>
				Effect.gen(function* () {
					const local = yield* options.identity(repoRoot, baseRef);
					if (state.has(local.key)) return;
					yield* refresh(repoRoot, baseRef);
				}),
			stale: (key: string) => state.get(key)?.result?.baseMayBeStale ?? true,
		};
	});
