import { eventIterator, oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * The four adapters `@repo/harness-local` can drive — see PLAN.md, Phase 3,
 * "Running the harness locally." Availability can't be detected (no
 * `isAvailable` API on any adapter), so `harnesses` always reports all four
 * and lets a real failure surface at `generate` time instead.
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
 * being reused; `"unavailable"` — discovery has never once succeeded, so
 * `models` is empty. The harness itself stays selectable and `enabled`
 * regardless of this value — it only ever describes `models`, never gates
 * the checkbox.
 */
export const ModelsStatus = Schema.Literals(["fresh", "stale", "unavailable"]);
export type ModelsStatus = Schema.Schema.Type<typeof ModelsStatus>;

/**
 * `enabled` reflects `@repo/settings`'s `enabledHarnesses` (unset counts as
 * every harness enabled — see that package's `Settings.enabledHarnesses`
 * comment), not availability. All four entries are always present — the
 * onboarding picker needs to render all four as checkboxes — but `models` is
 * only discovered live when a harness is enabled, since discovery is real
 * I/O (a subprocess per harness); a disabled harness gets an empty `models`
 * list and `modelsStatus: "unavailable"` rather than paying for discovery
 * nobody will use yet.
 */
export const HarnessInfo = Schema.Struct({
	id: HarnessId,
	label: Schema.String,
	models: Schema.Array(HarnessModel),
	enabled: Schema.Boolean,
	modelsStatus: ModelsStatus,
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
	status: Schema.Literals(["running", "done", "failed"]),
});
export type ActiveGeneration = Schema.Schema.Type<typeof ActiveGeneration>;

export const walkthroughContract = {
	/** All four adapters, each flagged `enabled` — never errors, since availability isn't knowable up front. */
	harnesses: oc.output(Schema.Array(HarnessInfo)),
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
};
