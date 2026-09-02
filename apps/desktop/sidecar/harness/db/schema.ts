import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per harness id (`claude-code`/`codex`/`opencode`/`pi`) — the
 * persisted half of `HarnessModelCache` (`../model-store.ts`), which is what
 * makes a discovered model list survive a sidecar restart instead of every
 * boot starting the stale-while-revalidate cycle from a cold, empty cache.
 *
 * `modelsJson`/`fetchedAt` are the last *successful* discovery only —
 * written together, both left untouched by a failed attempt (see
 * `model-store.ts`'s `writeFailure`) so a run of failures can never erase a
 * previously-good model list out from under the picker. `lastAttemptAt`/
 * `consecutiveFailures`/`lastError` track the most recent attempt
 * regardless of outcome, which is what `model-store.ts`'s backoff curve
 * reads to decide whether a stale-and-failing harness is due for another
 * live probe yet.
 */
export const harnessModelDiscoveries = sqliteTable(
	"harness_model_discoveries",
	{
		id: integer().primaryKey({ autoIncrement: true }),
		harnessId: text().notNull().unique(),
		/** JSON-encoded `ReadonlyArray<HarnessModel>` — `null` until the first successful discovery ever lands. */
		modelsJson: text(),
		/** Set only on a successful discovery; `null` if none has ever succeeded. */
		fetchedAt: integer({ mode: "timestamp_ms" }),
		/** Every attempt, success or failure — what the backoff curve measures elapsed time against. */
		lastAttemptAt: integer({ mode: "timestamp_ms" }).notNull(),
		/** Reset to 0 by a success; incremented by a failure. Drives the backoff curve in `model-store.ts`. */
		consecutiveFailures: integer({ mode: "number" }).notNull().default(0),
		/** The most recent failure's message, truncated — observability only, never read by the cache logic itself. */
		lastError: text(),
	},
);
