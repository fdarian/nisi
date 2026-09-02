import { SqliteDb } from "@repo/db";
import type { HarnessId, HarnessModel, ModelsStatus } from "@repo/sidecar-api";
import { applyEmbeddedMigrations } from "deskkit/sqlite";
import { eq } from "drizzle-orm";
import {
	Context,
	Deferred,
	Duration,
	Effect,
	Layer,
	Ref,
	Result,
	Schema,
} from "effect";
import migrationBundle from "../../.gen/migrations.gen.ts";
import { harnessModelDiscoveries } from "./db/schema.ts";
import type { DiscoveryReason } from "./model-discovery.ts";

export class HarnessModelCacheError extends Schema.TaggedError<HarnessModelCacheError>()(
	"HarnessModelCacheError",
	{ cause: Schema.Defect() },
) {}

export type DiscoveryResult = {
	readonly models: ReadonlyArray<HarnessModel>;
	readonly status: ModelsStatus;
};

type Discover = (
	reason: DiscoveryReason,
) => Effect.Effect<ReadonlyArray<HarnessModel>, unknown>;

/** How long a successful discovery is trusted before the next `harnesses()` call revalidates it in the background, rather than blocking on a live probe. */
const TTL_MS = Duration.toMillis(Duration.hours(24));

/**
 * How long a harness sits out after a failed discovery before another live
 * probe is attempted — doubling per consecutive failure, capped at
 * `TTL_MS` (waiting longer than a healthy harness's own revalidation
 * cadence buys nothing). A harness whose CLI is simply missing never
 * reaches this at all — `harnesses.ts`'s `available` check skips discovery
 * entirely before `get` is ever called. This backs off a harness that *is*
 * present but failing (expired auth, a hung install, a real bug), so a
 * broken harness stops spawning a fresh probe process on every UI mount —
 * the failure-side half of the thundering-herd bug the cadence audit
 * traced: the old cache never persisted a failure at all, so the very next
 * mount respawned with no memory of the last attempt.
 */
const BASE_BACKOFF_MS = Duration.toMillis(Duration.minutes(1));
const backoffMs = (consecutiveFailures: number): number =>
	Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), TTL_MS);

type Row = typeof harnessModelDiscoveries.$inferSelect;

const parseModels = (json: string | null): ReadonlyArray<HarnessModel> => {
	if (json === null) return [];
	try {
		return JSON.parse(json) as ReadonlyArray<HarnessModel>;
	} catch {
		return [];
	}
};

type Decision =
	| { readonly kind: "cold" }
	| {
			readonly kind: "warm";
			readonly result: DiscoveryResult;
			readonly shouldRevalidate: boolean;
	  };

/**
 * The read side of the cache: given the persisted row (if any) and the
 * current time, decides what to serve *and* whether a background
 * revalidation is warranted. Pure — no I/O of its own — so the
 * fresh/stale/backoff/cold matrix is checkable without a database, and
 * `get` below is the only place that has to reason about I/O ordering.
 */
const decide = (row: Row | undefined, now: number): Decision => {
	if (row === undefined) return { kind: "cold" };

	const fetchedAt = row.fetchedAt?.getTime();
	if (fetchedAt !== undefined && now - fetchedAt < TTL_MS) {
		return {
			kind: "warm",
			result: { models: parseModels(row.modelsJson), status: "fresh" },
			shouldRevalidate: false,
		};
	}

	// Past the TTL, or a row that has never once succeeded (`fetchedAt` is
	// still `null` — every attempt so far has failed). Either way there's
	// nothing fresh to serve; the only question left is whether a
	// consecutive-failure backoff is still in effect for the *next* probe.
	const hasModels = fetchedAt !== undefined;
	const backedOff =
		row.consecutiveFailures > 0 &&
		now - row.lastAttemptAt.getTime() < backoffMs(row.consecutiveFailures);

	return {
		kind: "warm",
		result: {
			models: hasModels ? parseModels(row.modelsJson) : [],
			status: hasModels ? "stale" : "unavailable",
		},
		shouldRevalidate: !backedOff,
	};
};

/**
 * Persistent (SQLite), single-flight, stale-while-revalidate cache for
 * `model-discovery.ts`'s per-harness model lists — replaces the old
 * in-memory 5-minute-TTL `Map` (`model-discovery.ts`'s former
 * `createModelDiscoveryCache`). That cache had two gaps the cadence audit
 * traced directly to a production symptom (four `claude` processes spawned
 * within 13 seconds): it wrote its entry only *after* `discover` resolved,
 * so any caller landing while a discovery was already in flight saw the
 * same stale/missing entry and spawned its own subprocess too; and it never
 * remembered a *failure*, so a harness stuck failing respawned a fresh
 * probe on literally every UI mount, with no backoff and no persistence
 * across a sidecar restart.
 *
 * Semantics per harness id, decided by `decide` above:
 * - **cold** (no row yet): blocks the caller on a real discovery attempt —
 *   the picker must never render a harness as empty just because the cache
 *   hadn't been touched yet.
 * - **warm, fresh** (a success within `TTL_MS`): served straight from the
 *   row, no I/O beyond the read.
 * - **warm, stale-or-never-succeeded**: served immediately from whatever
 *   the row already has (the last good model list, flagged `"stale"`, or an
 *   empty `"unavailable"` list if nothing has ever succeeded) — and, unless
 *   a failure backoff is still running, a revalidation is forked into the
 *   background (`Effect.forkDetach`, the same "outlive the RPC handler that
 *   triggered it" shape `updater/service.ts`'s `download` uses) instead of
 *   blocking the caller a second time.
 *
 * Every discovery attempt — cold, background, or `force`d — goes through
 * `runExclusive`, which single-flights concurrent callers for the same
 * harness id behind one `Deferred`: a second caller arriving while the
 * first is still in flight joins that same attempt rather than spawning a
 * subprocess of its own.
 */
export class HarnessModelCache extends Context.Service<HarnessModelCache>()(
	"HarnessModelCache",
	{
		make: Effect.gen(function* () {
			const db = yield* SqliteDb;
			// Own `migrationsTable`, distinct from every other domain's — see
			// `@repo/db`'s AGENTS.md for why sharing the default name silently
			// drops one domain's migration.
			yield* applyEmbeddedMigrations(
				db,
				migrationBundle,
				"__drizzle_migrations_harness",
			).pipe(Effect.mapError((cause) => new HarnessModelCacheError({ cause })));

			/** A drizzle query's own typed failure, re-mapped onto this service's error — mirrors `WalkthroughStore`'s `query` helper. */
			const query = <A, E>(effect: Effect.Effect<A, E>) =>
				effect.pipe(
					Effect.mapError((cause) => new HarnessModelCacheError({ cause })),
				);

			const readRow = (id: HarnessId): Effect.Effect<Row | undefined> =>
				query(
					db
						.select()
						.from(harnessModelDiscoveries)
						.where(eq(harnessModelDiscoveries.harnessId, id)),
				).pipe(
					Effect.map((rows) => rows[0]),
					// A read failure degrades to "cold" rather than failing the
					// whole call — `decide` treats `undefined` the same as "never
					// seen this harness," which is the safest wrong answer: it
					// blocks on a fresh discovery instead of silently trusting
					// data it couldn't actually read.
					Effect.catchTag("HarnessModelCacheError", (error) =>
						Effect.logWarning(
							"failed to read the harness model discovery cache -- treating as cold",
							{ harnessId: id, cause: error.cause },
						).pipe(Effect.as(undefined)),
					),
				);

			const writeSuccess = (
				id: HarnessId,
				models: ReadonlyArray<HarnessModel>,
				now: Date,
			): Effect.Effect<void> => {
				const values = {
					harnessId: id,
					modelsJson: JSON.stringify(models),
					fetchedAt: now,
					lastAttemptAt: now,
					consecutiveFailures: 0,
					lastError: null,
				};
				return query(
					db.insert(harnessModelDiscoveries).values(values).onConflictDoUpdate({
						target: harnessModelDiscoveries.harnessId,
						set: values,
					}),
				).pipe(
					Effect.asVoid,
					// A failure to *persist* a successful discovery still hands the
					// caller the live result (see `runExclusive`) — only the next
					// call's cache hit is what's lost, not this one's answer.
					Effect.catchTag("HarnessModelCacheError", (error) =>
						Effect.logWarning(
							"failed to persist a successful harness model discovery",
							{ harnessId: id, cause: error.cause },
						),
					),
				);
			};

			const writeFailure = (
				id: HarnessId,
				previousFailures: number,
				now: Date,
				error: unknown,
			): Effect.Effect<void> => {
				const consecutiveFailures = previousFailures + 1;
				const lastError = (
					error instanceof Error ? error.message : String(error)
				).slice(0, 500);
				return query(
					db
						.insert(harnessModelDiscoveries)
						.values({
							harnessId: id,
							modelsJson: null,
							fetchedAt: null,
							lastAttemptAt: now,
							consecutiveFailures,
							lastError,
						})
						// `modelsJson`/`fetchedAt` deliberately absent from `set` below —
						// on a conflict (a row already exists) they're left exactly as
						// they were, so a failure can never overwrite a previously-good
						// model list. Only the insert-branch `.values()` above ever
						// writes them, and only as `null`, for a harness whose very
						// first attempt is this failure.
						.onConflictDoUpdate({
							target: harnessModelDiscoveries.harnessId,
							set: { lastAttemptAt: now, consecutiveFailures, lastError },
						}),
				).pipe(
					Effect.asVoid,
					Effect.catchTag("HarnessModelCacheError", (error) =>
						Effect.logWarning(
							"failed to persist a failed harness model discovery",
							{ harnessId: id, cause: error.cause },
						),
					),
				);
			};

			/** One in-flight `Deferred` per harness id currently being discovered — see the class doc for why. */
			const inFlight = yield* Ref.make(
				new Map<HarnessId, Deferred.Deferred<DiscoveryResult, never>>(),
			);

			const runExclusive = (
				id: HarnessId,
				discover: Discover,
				reason: DiscoveryReason,
			): Effect.Effect<DiscoveryResult> =>
				Effect.gen(function* () {
					const mine = yield* Deferred.make<DiscoveryResult, never>();
					const leader = yield* Ref.modify(inFlight, (map) => {
						const existing = map.get(id);
						if (existing !== undefined) return [existing, map] as const;
						const next = new Map(map);
						next.set(id, mine);
						return [mine, next] as const;
					});

					if (leader !== mine) {
						yield* Effect.logDebug(
							"harness model discovery already in flight -- joining it instead of spawning a second one",
							{ harnessId: id, reason },
						);
						return yield* Deferred.await(leader);
					}

					const attempt = yield* Effect.result(discover(reason));
					const now = new Date();
					const result: DiscoveryResult = yield* Result.isSuccess(attempt)
						? writeSuccess(id, attempt.success, now).pipe(
								Effect.as({
									models: attempt.success,
									status: "fresh" as const,
								}),
							)
						: Effect.gen(function* () {
								// Read fresh rather than trust a snapshot taken before this
								// call claimed leadership — single-flight means only the
								// leader ever writes, so this read-then-write is race-free
								// for `consecutiveFailures`, and it also doubles as what to
								// serve this attempt's own caller.
								const previous = yield* readRow(id);
								yield* writeFailure(
									id,
									previous?.consecutiveFailures ?? 0,
									now,
									attempt.failure,
								);
								const hasModels = previous?.fetchedAt != null;
								return {
									models: hasModels
										? parseModels(previous?.modelsJson ?? null)
										: [],
									status: hasModels
										? ("stale" as const)
										: ("unavailable" as const),
								};
							});

					yield* Deferred.succeed(mine, result);
					yield* Ref.update(inFlight, (map) => {
						const next = new Map(map);
						next.delete(id);
						return next;
					});
					return result;
				});

			const get = (
				id: HarnessId,
				discover: Discover,
				opts?: { readonly force?: boolean },
			): Effect.Effect<DiscoveryResult> =>
				Effect.gen(function* () {
					// `force` (the manual refresh escape hatch, `walkthrough.
					// refreshHarnesses`) bypasses both the TTL and the failure
					// backoff, but still goes through `runExclusive` — concurrent
					// force calls (or a force landing while a background
					// revalidation is already running) share one attempt rather
					// than each spawning their own.
					if (opts?.force === true) {
						return yield* runExclusive(id, discover, "forced-refresh");
					}

					const row = yield* readRow(id);
					const decision = decide(row, Date.now());
					if (decision.kind === "cold") {
						return yield* runExclusive(id, discover, "cold-miss");
					}

					if (decision.shouldRevalidate) {
						yield* runExclusive(id, discover, "background-revalidation").pipe(
							Effect.forkDetach,
						);
					}
					return decision.result;
				});

			return { get };
		}),
	},
) {
	static layer = Layer.effect(HarnessModelCache, HarnessModelCache.make);
}
