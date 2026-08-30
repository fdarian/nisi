import { SqliteDb } from "@repo/db";
import type { HarnessId, UncoveredFile } from "@repo/sidecar-api";
import { type WalkthroughRow, walkthroughs } from "@repo/walkthrough/db";
import migrationBundle from "@repo/walkthrough/db-migrations";
import { applyEmbeddedMigrations } from "deskkit/sqlite";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Schema } from "effect";

export class WalkthroughStoreError extends Schema.TaggedError<WalkthroughStoreError>()(
	"WalkthroughStoreError",
	{ cause: Schema.Defect() },
) {}

/**
 * The `content` column's on-disk shape: the walkthrough (opaque to this
 * store, never decoded against `@repo/walkthrough`'s schema) plus its
 * derived coverage gaps, nested in one envelope instead of a new column — no
 * migration needed to persist `uncoveredFiles` this way.
 */
type StoredContentEnvelope = {
	readonly walkthrough: unknown;
	readonly uncoveredFiles: ReadonlyArray<UncoveredFile>;
};

/** `parseContent`'s result — `uncoveredFiles` is `undefined`, not `[]`, for a row written before this envelope existed. Its `content` *is* the bare walkthrough JSON (no `walkthrough` key), meaning coverage was never computed for it, not computed-and-empty; collapsing that into `[]` would tell a caller "this walkthrough covers everything" about a row nobody ever checked. Only a genuinely-computed empty array (a new row whose walkthrough really did cover every hunk) may decode as `[]`. */
type ParsedContent = {
	readonly walkthrough: unknown;
	readonly uncoveredFiles: ReadonlyArray<UncoveredFile> | undefined;
};

const isEnvelope = (value: unknown): value is StoredContentEnvelope =>
	value !== null && typeof value === "object" && "walkthrough" in value;

const parseContent = (raw: string): ParsedContent => {
	const parsed: unknown = JSON.parse(raw);
	return isEnvelope(parsed)
		? { walkthrough: parsed.walkthrough, uncoveredFiles: parsed.uncoveredFiles }
		: { walkthrough: parsed, uncoveredFiles: undefined };
};

/** The wire-shape-adjacent record `walkthrough.get`/`generate`'s `done` event hand back — `@repo/sidecar-api`'s `StoredWalkthrough` minus the parsed `walkthrough` field, which the caller decodes from `content`. */
export type StoredWalkthroughRecord = {
	readonly sessionId: string;
	readonly harness: HarnessId;
	readonly model: string | null;
	/** JSON-encoded `@repo/walkthrough`'s `Walkthrough` — left as text so this store never needs to import that package's schema just to round-trip it. Already unwrapped from `content`'s on-disk envelope. */
	readonly content: string;
	/** `undefined` for a row predating this field — coverage was never computed for it, distinct from a real (possibly empty) array meaning it was. */
	readonly uncoveredFiles: ReadonlyArray<UncoveredFile> | undefined;
	readonly fingerprints: Record<string, string>;
	readonly generatedAt: number;
};

const toRecord = (row: WalkthroughRow): StoredWalkthroughRecord => {
	const envelope = parseContent(row.content);
	return {
		sessionId: row.sessionId,
		harness: row.harness as HarnessId,
		model: row.model,
		content: JSON.stringify(envelope.walkthrough),
		uncoveredFiles: envelope.uncoveredFiles,
		fingerprints: JSON.parse(row.fingerprints) as Record<string, string>,
		generatedAt: row.updatedAt.getTime(),
	};
};

export type SaveWalkthroughInput = {
	readonly sessionId: string;
	readonly harness: HarnessId;
	readonly model: string | null;
	/** The decoded `@repo/walkthrough` `Walkthrough` — this store re-serializes it into `content`'s on-disk envelope but never imports that package's schema to validate it; the caller (already holding a decoded `WalkthroughEvaluation`) is the one source of truth for its shape. */
	readonly walkthrough: unknown;
	readonly uncoveredFiles: ReadonlyArray<UncoveredFile>;
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
			const db = yield* SqliteDb;
			// Own `migrationsTable`, distinct from `@repo/review`'s — see
			// `@repo/db`'s AGENTS.md for why sharing the default name across two
			// domains silently drops one domain's migration.
			yield* applyEmbeddedMigrations(
				db,
				migrationBundle,
				"__drizzle_migrations_walkthrough",
			).pipe(Effect.mapError((cause) => new WalkthroughStoreError({ cause })));

			/** A drizzle query's own typed failure, re-mapped to this store's `WalkthroughStoreError` — the effect-native adapter already fails typed, so this is the only wrapping a query needs. */
			const query = <A, E>(effect: Effect.Effect<A, E>) =>
				effect.pipe(
					Effect.mapError((cause) => new WalkthroughStoreError({ cause })),
				);

			const get = (
				sessionId: string,
			): Effect.Effect<StoredWalkthroughRecord | null, WalkthroughStoreError> =>
				query(
					db
						.select()
						.from(walkthroughs)
						.where(eq(walkthroughs.sessionId, sessionId))
						.limit(1),
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
					const envelope: StoredContentEnvelope = {
						walkthrough: input.walkthrough,
						uncoveredFiles: input.uncoveredFiles,
					};
					const values = {
						sessionId: input.sessionId,
						harness: input.harness,
						model: input.model,
						content: JSON.stringify(envelope),
						fingerprints: JSON.stringify(input.fingerprints),
						updatedAt: now,
					};
					const row = yield* query(
						db
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
