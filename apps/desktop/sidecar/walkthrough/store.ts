import {
	applyEmbeddedMigrations,
	type DrizzleClient,
	dbUse,
	SqliteDb,
} from "@repo/db";
import type { HarnessId } from "@repo/sidecar-api";
import { type WalkthroughRow, walkthroughs } from "@repo/walkthrough/db";
import migrationBundle from "@repo/walkthrough/db-migrations";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

export class WalkthroughStoreError extends Schema.TaggedErrorClass<WalkthroughStoreError>()(
	"WalkthroughStoreError",
	{ cause: Schema.Defect() },
) {}

/** The wire-shape-adjacent record `walkthrough.get`/`generate`'s `done` event hand back — `@repo/sidecar-api`'s `StoredWalkthrough` minus the parsed `walkthrough` field, which the caller decodes from `content`. */
export type StoredWalkthroughRecord = {
	readonly sessionId: string;
	readonly harness: HarnessId;
	readonly model: string | null;
	/** JSON-encoded `@repo/walkthrough`'s `Walkthrough` — left as text so this store never needs to import that package's schema just to round-trip it. */
	readonly content: string;
	readonly fingerprints: Record<string, string>;
	readonly generatedAt: number;
};

const toRecord = (row: WalkthroughRow): StoredWalkthroughRecord => ({
	sessionId: row.sessionId,
	harness: row.harness as HarnessId,
	model: row.model,
	content: row.content,
	fingerprints: JSON.parse(row.fingerprints) as Record<string, string>,
	generatedAt: row.updatedAt.getTime(),
});

export type SaveWalkthroughInput = {
	readonly sessionId: string;
	readonly harness: HarnessId;
	readonly model: string | null;
	readonly content: string;
	readonly fingerprints: Record<string, string>;
};

/**
 * Persistence for generated walkthroughs — one row per session (regenerating
 * overwrites). Lives here, not in `@repo/walkthrough`, because that package
 * is deliberately I/O-free; this service is the wiring layer's job (see
 * `@repo/walkthrough`'s AGENTS.md).
 */
export class WalkthroughStore extends Context.Service<WalkthroughStore>()(
	"WalkthroughStore",
	{
		make: Effect.gen(function* () {
			const { db } = yield* SqliteDb;
			yield* applyEmbeddedMigrations(db, migrationBundle).pipe(
				Effect.mapError((cause) => new WalkthroughStoreError({ cause })),
			);

			const query = <T>(fn: (client: DrizzleClient) => T) =>
				dbUse(db, fn).pipe(
					Effect.mapError((cause) => new WalkthroughStoreError({ cause })),
				);

			const get = (
				sessionId: string,
			): Effect.Effect<StoredWalkthroughRecord | null, WalkthroughStoreError> =>
				query((client) =>
					client
						.select()
						.from(walkthroughs)
						.where(eq(walkthroughs.sessionId, sessionId))
						.limit(1)
						.all(),
				).pipe(
					Effect.map((rows) =>
						rows.at(0) === undefined
							? null
							: toRecord(rows[0] as WalkthroughRow),
					),
				);

			const save = (
				input: SaveWalkthroughInput,
			): Effect.Effect<StoredWalkthroughRecord, WalkthroughStoreError> =>
				Effect.gen(function* () {
					const now = new Date();
					const values = {
						sessionId: input.sessionId,
						harness: input.harness,
						model: input.model,
						content: input.content,
						fingerprints: JSON.stringify(input.fingerprints),
						updatedAt: now,
					};
					const row = yield* query((client) =>
						client
							.insert(walkthroughs)
							.values({ ...values, createdAt: now })
							.onConflictDoUpdate({
								target: walkthroughs.sessionId,
								set: values,
							})
							.returning()
							.get(),
					);
					return toRecord(row);
				});

			return { get, save };
		}),
	},
) {
	static layer = Layer.effect(WalkthroughStore, WalkthroughStore.make);
}
