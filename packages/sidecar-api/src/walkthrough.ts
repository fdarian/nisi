import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * The four adapters `@repo/harness-local` can drive. `harnesses` always
 * reports all four regardless of whether each is currently `available` (see
 * `HarnessInfo`) — the onboarding picker and the settings page both need
 * every harness as a row, not a filtered list.
 */
export const HarnessId = Schema.Literals([
	"claude-code",
	"codex",
	"opencode",
	"pi",
]);
export type HarnessId = Schema.Schema.Type<typeof HarnessId>;

/** One selectable model for a harness. All four harnesses discover these live — see `apps/desktop/sidecar/walkthrough/model-discovery.ts`. */
export const HarnessModel = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
});
export type HarnessModel = Schema.Schema.Type<typeof HarnessModel>;

/**
 * Provenance of `HarnessInfo.models` relative to `model-discovery.ts`'s
 * cache: `"fresh"` — discovered (or cache-hit within the TTL) this call;
 * `"stale"` — the live attempt failed but a previous successful discovery is
 * being reused; `"unavailable"` — either discovery has never once succeeded,
 * or the harness's `available` is `false` (its CLI isn't present, so
 * discovery isn't even attempted — see `HarnessInfo`'s doc for why a missing
 * binary is never reported `"stale"`). The harness itself stays selectable
 * and `enabled` regardless of this value — it only ever describes `models`,
 * never gates the checkbox on its own (`available` does that — see below).
 */
export const ModelsStatus = Schema.Literals(["fresh", "stale", "unavailable"]);
export type ModelsStatus = Schema.Schema.Type<typeof ModelsStatus>;

/**
 * `available` and `enabled` are independent and both always present, one per
 * harness:
 * - **`available`** — is the harness's CLI actually present on this machine
 *   right now? A live, cheap filesystem check via `@repo/bin-resolver`
 *   (`apps/desktop/sidecar/walkthrough/availability.ts`), never cached
 *   itself (unlike `models`, which is real subprocess I/O) — so every
 *   `harnesses()` call reflects the current install state with no
 *   staleness of its own. Pi has no CLI (a bundled library dependency, not
 *   a subprocess) and is always `available: true`. `binaryPath` is the
 *   resolved absolute path when found, so the UI can show *which* binary
 *   was picked; `null` when unavailable (or for Pi, where there's no single
 *   binary to name).
 * - **`enabled`** — has the user chosen to use it? Reflects `@repo/settings`'s
 *   `enabledHarnesses` (unset counts as every harness enabled — see that
 *   package's `Settings.enabledHarnesses` comment). A user declaration, not
 *   a probe — independent of `available`, so a harness can be enabled from a
 *   previous machine state but currently unavailable, or available but not
 *   yet enabled.
 *
 * All four entries are always present — the onboarding picker and the
 * settings page both need every harness as a row, checkbox included, even
 * an unavailable one (so the user can see it's an option they could
 * install). `models` is only discovered live when a harness is both
 * `enabled` *and* `available` — no point paying for discovery's subprocess
 * on a harness nobody's turned on, or one whose CLI isn't even there to ask.
 * Anything short of that gets an empty `models` list and
 * `modelsStatus: "unavailable"`.
 */
export const HarnessInfo = Schema.Struct({
	id: HarnessId,
	label: Schema.String,
	models: Schema.Array(HarnessModel),
	enabled: Schema.Boolean,
	modelsStatus: ModelsStatus,
	available: Schema.Boolean,
	binaryPath: Schema.NullOr(Schema.String),
});
export type HarnessInfo = Schema.Schema.Type<typeof HarnessInfo>;

/**
 * Mirrors `@repo/walkthrough`'s `Location`/`ReferenceBlock`/`Section`/`Walkthrough`
 * — redeclared here rather than imported, same as `diff.ts`'s `FileChange`
 * mirrors `@repo/git`'s: this package stays dependency-free from every domain
 * package, consumed only by the sidecar's implementation.
 */
export const Location = Schema.Struct({
	path: Schema.String,
	startLine: Schema.Number,
	endLine: Schema.Number,
});
export type Location = Schema.Schema.Type<typeof Location>;

export const ReferenceBlock = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	locations: Schema.Array(Location),
});
export type ReferenceBlock = Schema.Schema.Type<typeof ReferenceBlock>;

export const Section = Schema.Struct({
	title: Schema.String,
	body: Schema.String,
});
export type Section = Schema.Schema.Type<typeof Section>;

export const Walkthrough = Schema.Struct({
	version: Schema.Literal(1),
	sections: Schema.Array(Section),
	references: Schema.Array(ReferenceBlock),
});
export type Walkthrough = Schema.Schema.Type<typeof Walkthrough>;

/**
 * A generated walkthrough as persisted — one per session, regenerating
 * overwrites. `fingerprints` is the file-path → `@repo/git` `FileChange.fingerprint`
 * map captured at generation time; the frontend compares it against a
 * session's *current* `diff.files` fingerprints to mark individual
 * references outdated, rather than the sidecar computing staleness itself.
 */
export const StoredWalkthrough = Schema.Struct({
	sessionId: Schema.String,
	harness: HarnessId,
	model: Schema.NullOr(Schema.String),
	walkthrough: Walkthrough,
	fingerprints: Schema.Record(Schema.String, Schema.String),
	generatedAt: Schema.Number,
});
export type StoredWalkthrough = Schema.Schema.Type<typeof StoredWalkthrough>;

/**
 * Progress events for `generate`'s stream. Cold start alone is ~13-28s
 * before the agent says anything (see `@repo/harness-local`'s AGENTS.md), so
 * these need to carry enough for the UI to show real progress rather than a
 * bare spinner — which turn, which tool, why a retry is happening.
 */
export const GenerateEvent = Schema.Union([
	/** Sandbox session creation — the slow step on a cold CLI-install run. */
	Schema.Struct({ type: Schema.Literal("bootstrapping") }),
	Schema.Struct({ type: Schema.Literal("turn-started"), turn: Schema.Number }),
	Schema.Struct({
		type: Schema.Literal("tool-call"),
		turn: Schema.Number,
		toolName: Schema.String,
		input: Schema.Unknown,
	}),
	/** Coverage/reference validation rejected the turn's buffer; `feedback` is what's fed back to the agent for the next turn. */
	Schema.Struct({
		type: Schema.Literal("validation-failed"),
		turn: Schema.Number,
		feedback: Schema.String,
	}),
	Schema.Struct({ type: Schema.Literal("retrying"), turn: Schema.Number }),
	Schema.Struct({
		type: Schema.Literal("done"),
		walkthrough: StoredWalkthrough,
	}),
	Schema.Struct({ type: Schema.Literal("failed"), message: Schema.String }),
	/** Terminal outcome of a user-initiated `stop` — distinct from `failed` since nothing went wrong, the generation just ended on request rather than by finishing or erroring. */
	Schema.Struct({ type: Schema.Literal("cancelled") }),
]);
export type GenerateEvent = Schema.Schema.Type<typeof GenerateEvent>;

/**
 * A snapshot of the generation the sidecar is currently retaining for one
 * session — whatever `generate`'s stream has produced so far, kept in memory
 * so a subscriber that reattaches (tab switch, reload) can catch up instead
 * of finding nothing. `events` is the *entire* backlog from `bootstrapping`
 * onward, including the terminal `done`/`failed` entry once the generation
 * has finished — so this doubles as "what happened to my last generate call"
 * even after the fact, e.g. a failure nobody was around to see. `status`
 * mirrors the last event's type (`"running"` until a terminal one lands).
 * Gone on sidecar restart, same as `live-sessions.ts`'s in-process map — see
 * `apps/desktop/sidecar/walkthrough/generation-log.ts`.
 */
export const ActiveGeneration = Schema.Struct({
	harness: HarnessId,
	model: Schema.NullOr(Schema.String),
	events: Schema.Array(GenerateEvent),
	status: Schema.Literals(["running", "done", "failed", "cancelled"]),
});
export type ActiveGeneration = Schema.Schema.Type<typeof ActiveGeneration>;

export const walkthroughContract = {
	/**
	 * All four adapters, each flagged `enabled` and `available` — never
	 * errors. Serves cached model discovery (see `HarnessInfo`'s doc) and a
	 * live `available` check on every call.
	 */
	harnesses: oc.output(Schema.Array(HarnessInfo)),
	/**
	 * Same shape and behavior as `harnesses`, except it bypasses
	 * `model-discovery.ts`'s cache — every enabled+available harness's model
	 * list is re-fetched live rather than served from the TTL cache. For an
	 * explicit user-initiated refresh (a refresh icon in the UI), not for
	 * routine reads: `available` is already live on every `harnesses()` call
	 * on its own, so this only buys anything for `models`/`modelsStatus`.
	 */
	refreshHarnesses: oc.output(Schema.Array(HarnessInfo)),
	/** `null` when the session has no generated walkthrough yet — not an error. */
	get: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.NullOr(StoredWalkthrough))
		.errors({ NOT_FOUND: {} }),
	/**
	 * `null` when nothing is retained for this session — no generation has
	 * run since the sidecar last started, or its retained log was overwritten
	 * by a newer `generate` call. A pure read, no side effects: safe to call
	 * on every mount/tab-focus to decide whether to render a resumed progress
	 * timeline, unlike `generate` itself (see below), which is safe to call
	 * repeatedly too but only because it *reattaches* rather than because
	 * it's side-effect-free — call this one first if the goal is just to look.
	 */
	activeGeneration: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.NullOr(ActiveGeneration))
		.errors({ NOT_FOUND: {} }),
	// `eventIterator` wants a Standard Schema, same as `events.subscribe` —
	// see `events.ts`'s comment on why `oc.output()`'s Effect-Schema patch
	// doesn't cover it.
	/**
	 * Starts a generation, *or* reattaches to one already running for
	 * `sessionId` — the sidecar decides which by what it finds retained (see
	 * `generation-log.ts`). Reattaching replays every event produced so far
	 * before continuing live, so a caller that missed the start (a fresh
	 * subscribe after a tab switch, e.g.) still sees the full timeline. When
	 * reattaching, `harness`/`model` are ignored — whatever's already running
	 * wins, since a session only ever has one generation in flight.
	 */
	generate: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				harness: HarnessId,
				model: Schema.optional(Schema.String),
			}),
		)
		.output(eventIterator(Schema.toStandardSchemaV1(GenerateEvent)))
		.errors({ NOT_FOUND: {} }),
	/**
	 * Aborts the generation currently running for `sessionId`, if any — a
	 * no-op, not an error, when nothing's running (already finished, or never
	 * started). The aborted generation's stream yields a terminal `cancelled`
	 * event rather than `failed`. `NOT_FOUND` is reserved for an unknown
	 * `sessionId`, same as `generate`'s siblings.
	 */
	stop: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
};
