import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * `status`'s outcome, six mutually exclusive states rather than a
 * boolean-plus-flags pile, since the UI needs to render a genuinely
 * different affordance for each: `unsupported` — no `tsconfig*.json`
 * anywhere in the repo, so there's nothing for scip-typescript to index (no
 * build button at all); `absent` — supported, but never built (a "build
 * index" prompt); `building` — a `build` call is in flight (a spinner, no
 * new `build` needed); `ready` — the cached index matches the repo's
 * current head exactly; `stale` — a cached index exists but for an older
 * head (an "index out of date, rebuild?" affordance, while still usable for
 * `fileOccurrences`/`references` in the meantime); `failed` — the most
 * recent `build` errored, with nothing usable cached.
 */
export const CodeIndexStatusKind = Schema.Literals([
	"unsupported",
	"absent",
	"building",
	"ready",
	"stale",
	"failed",
]);
export type CodeIndexStatusKind = Schema.Schema.Type<
	typeof CodeIndexStatusKind
>;

/**
 * `indexedHeadSha`/`generatedAt` describe whatever index is cached right
 * now, if any — both `null` for `unsupported`/`absent`, and for `building`
 * or `failed` when nothing has ever built successfully. They stay populated
 * for `building`/`failed` when an *older* successful build exists (a
 * rebuild in flight, or one that just failed, doesn't discard the index
 * still on disk from before), which is also what lets `fileOccurrences`/
 * `references` keep answering from a `stale` index while a fresher one
 * builds. `documentCount` is populated only for `ready` — a `stale` index
 * is still queryable, but its document count isn't surfaced as current
 * information here. `failureMessage` is populated only for `failed`.
 */
export const CodeIndexStatus = Schema.Struct({
	status: CodeIndexStatusKind,
	headSha: Schema.String,
	indexedHeadSha: Schema.NullOr(Schema.String),
	generatedAt: Schema.NullOr(Schema.Number),
	documentCount: Schema.NullOr(Schema.Number),
	failureMessage: Schema.NullOr(Schema.String),
});
export type CodeIndexStatus = Schema.Schema.Type<typeof CodeIndexStatus>;

/** One occurrence in a file — `symbolKey` is an opaque token, meaningful only as `references`' input, never parsed client-side. `hasDefinition`/`referenceCount` are index-wide (not "in this file"), computed once so a hover doesn't need a second round trip to know whether "Go to definition" would find anything. */
export const CodeIndexOccurrence = Schema.Struct({
	line: Schema.Number,
	charStart: Schema.Number,
	charEnd: Schema.Number,
	symbolKey: Schema.String,
	isDefinition: Schema.Boolean,
	hasDefinition: Schema.Boolean,
	referenceCount: Schema.Number,
});
export type CodeIndexOccurrence = Schema.Schema.Type<
	typeof CodeIndexOccurrence
>;

export const CodeIndexLocation = Schema.Struct({
	path: Schema.String,
	line: Schema.Number,
	charStart: Schema.Number,
	charEnd: Schema.Number,
});
export type CodeIndexLocation = Schema.Schema.Type<typeof CodeIndexLocation>;

/** One reference occurrence plus its source line's text — carried here rather than making the frontend fetch each file separately, since the peek preview needs to render immediately for every entry in the list. */
export const CodeIndexReference = Schema.Struct({
	line: Schema.Number,
	charStart: Schema.Number,
	charEnd: Schema.Number,
	lineText: Schema.String,
});
export type CodeIndexReference = Schema.Schema.Type<typeof CodeIndexReference>;

export const CodeIndexFileReferences = Schema.Struct({
	path: Schema.String,
	references: Schema.Array(CodeIndexReference),
});
export type CodeIndexFileReferences = Schema.Schema.Type<
	typeof CodeIndexFileReferences
>;

/**
 * `returnedReferenceCount` vs. `totalReferenceCount` is what lets the UI
 * render "showing N of M" rather than silently truncating — the sidecar
 * caps how many reference locations a single call returns (see
 * `apps/desktop/sidecar/code-index/state.ts`), since a widely-referenced
 * symbol (an exported type, a common utility) can have thousands.
 */
export const CodeIndexReferencesResult = Schema.Struct({
	displayName: Schema.String,
	documentation: Schema.Array(Schema.String),
	definition: Schema.NullOr(CodeIndexLocation),
	files: Schema.Array(CodeIndexFileReferences),
	totalReferenceCount: Schema.Number,
	returnedReferenceCount: Schema.Number,
});
export type CodeIndexReferencesResult = Schema.Schema.Type<
	typeof CodeIndexReferencesResult
>;

export const codeIndexContract = {
	/**
	 * A pure read — safe to call on every mount/tab-focus. Never builds
	 * anything itself; the frontend calls `build` separately and polls this
	 * to watch progress, the same "read vs. act" split as
	 * `walkthrough.activeGeneration` vs. `walkthrough.generate`.
	 */
	status: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(CodeIndexStatus)
		.errors({ NOT_FOUND: {} }),
	/**
	 * Starts a build for `sessionId`'s repo and returns immediately —
	 * `status` is what reports progress. A second `build` call while one's
	 * already running for this repo is a no-op, not an error: the existing
	 * build keeps going and the caller just polls the same `status` every
	 * other caller would. Not a streaming procedure on purpose — a ~15s job
	 * polled once a second is cheap enough that it doesn't earn the
	 * `eventIterator`/async-generator handler shape `walkthrough.generate`
	 * needs for genuinely live, multi-event progress.
	 */
	build: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Void)
		.errors({
			NOT_FOUND: {},
			UNSUPPORTED: {},
		}),
	/**
	 * Every occurrence in one file, fetched once per opened file so a hover
	 * is a purely local lookup against the response rather than a round trip
	 * per token — that's the whole reason this is shaped per-file instead of
	 * per-position. Empty (not an error) both for a file with no TypeScript
	 * symbols and for a repo with no index built yet — `status` is where a
	 * caller learns which case it is.
	 */
	fileOccurrences: oc
		.input(Schema.Struct({ sessionId: Schema.String, path: Schema.String }))
		.output(Schema.Array(CodeIndexOccurrence))
		.errors({ NOT_FOUND: {} }),
	/**
	 * `symbolKey` is always one echoed back by a prior `fileOccurrences`
	 * call. A `symbolKey` the index doesn't recognize (stale from an
	 * old index, e.g.) degrades to an empty result rather than an error —
	 * the same "absence is a value, not a failure" choice `fileOccurrences`
	 * makes for a repo with no index.
	 */
	references: oc
		.input(
			Schema.Struct({ sessionId: Schema.String, symbolKey: Schema.String }),
		)
		.output(CodeIndexReferencesResult)
		.errors({ NOT_FOUND: {} }),
};
