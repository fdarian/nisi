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

/** One selectable model for a harness. Only Pi discovers these live; the other three are this package's own curated static list — see `apps/desktop/sidecar/harnesses.ts`. */
export const HarnessModel = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
});
export type HarnessModel = Schema.Schema.Type<typeof HarnessModel>;

export const HarnessInfo = Schema.Struct({
	id: HarnessId,
	label: Schema.String,
	models: Schema.Array(HarnessModel),
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

export const walkthroughContract = {
	/** The static harness/model registry — never errors, since availability isn't knowable up front. */
	harnesses: oc.output(Schema.Array(HarnessInfo)),
	/** `null` when the session has no generated walkthrough yet — not an error. */
	get: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.NullOr(StoredWalkthrough))
		.errors({ NOT_FOUND: {} }),
	// `eventIterator` wants a Standard Schema, same as `events.subscribe` —
	// see `events.ts`'s comment on why `oc.output()`'s Effect-Schema patch
	// doesn't cover it.
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
