import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * One occurrence in a file — `symbolKey` is an opaque token, meaningful only
 * as `references`' input, never parsed client-side (it's an encoded
 * `path:line:char` position now, not a SCIP symbol string — still opaque to
 * every caller either way, so this is not a breaking change to this schema).
 * There is no `referenceCount` field — the SCIP index computed it for free
 * as an index-wide number; an LSP server would need one `references` round
 * trip per token to answer it, and nothing on the frontend reads it (verified
 * before dropping it, not assumed), so it was removed outright rather than
 * populated with a fabricated `0`. The peek panel's reference count
 * (`CodeIndexReferencesResult.totalReferenceCount`) is unaffected — that one
 * *is* the result of a real `references` call, made only once a symbol is
 * actually opened. `isDefinition`/`hasDefinition` were dropped the same way:
 * `hasDefinition` was `true` unconditionally (every occurrence came from a
 * real semantic token, and TypeScript's own token classifier only ever
 * labels named bindings), `isDefinition` was computed but never read on the
 * frontend — verified with a repo-wide grep before removing either, not
 * assumed.
 */
export const CodeIndexOccurrence = Schema.Struct({
	line: Schema.Number,
	charStart: Schema.Number,
	charEnd: Schema.Number,
	symbolKey: Schema.String,
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

/** Number of source lines padded before and after a code-index location. */
export const CODE_INDEX_SOURCE_CONTEXT_LINES_BEFORE = 10;
export const CODE_INDEX_SOURCE_CONTEXT_LINES_AFTER = 10;
export const CODE_INDEX_SOURCE_CONTEXT_LINE_COUNT =
	CODE_INDEX_SOURCE_CONTEXT_LINES_BEFORE +
	CODE_INDEX_SOURCE_CONTEXT_LINES_AFTER +
	1;

/**
 * A window of source lines around a code location — `lines[0]` is
 * `startLine` (0-based), so the location's own line is
 * `lines[location.line - startLine]`. The sidecar reads this from the same
 * worktree bytes that produced the LSP location; `referenceContext` exposes
 * this window on demand without making the frontend read files directly.
 */
export const CodeIndexSourceContext = Schema.Struct({
	startLine: Schema.Number,
	lines: Schema.Array(Schema.String),
});
export type CodeIndexSourceContext = Schema.Schema.Type<
	typeof CodeIndexSourceContext
>;

/**
 * One reference occurrence plus its source line. The selected row's padded
 * context is fetched lazily through `referenceContext`, so a large references
 * response does not carry the same 21 source lines once per row.
 *
 * `lineText` is `null` only when the sidecar genuinely couldn't read it —
 * the file is gone, or the recorded line no longer exists in a file that
 * got shorter (`apps/desktop/sidecar/code-index/state.ts`'s
 * `groupReferencesByFile`). There's no drift case to guard against anymore:
 * the LSP server that produced this location and the worktree read that
 * produced `lineText` both read the same live file off disk, at query time —
 * unlike the SCIP index this replaced, which was built once and could
 * silently disagree with a file edited afterward.
 */
export const CodeIndexReference = Schema.Struct({
	line: Schema.Number,
	charStart: Schema.Number,
	charEnd: Schema.Number,
	lineText: Schema.NullOr(Schema.String),
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
 *
 * `definitionContext` is `null` both when there's no `definition` to begin
 * with and when there is one but its file couldn't be read. Reference context
 * is loaded on demand through `referenceContext`; a missing file is a
 * legitimate `null` result while a read failure is an error.
 */
export const CodeIndexReferencesResult = Schema.Struct({
	displayName: Schema.String,
	documentation: Schema.Array(Schema.String),
	definition: Schema.NullOr(CodeIndexLocation),
	definitionContext: Schema.NullOr(CodeIndexSourceContext),
	files: Schema.Array(CodeIndexFileReferences),
	totalReferenceCount: Schema.Number,
	returnedReferenceCount: Schema.Number,
});
export type CodeIndexReferencesResult = Schema.Schema.Type<
	typeof CodeIndexReferencesResult
>;

export const codeIndexContract = {
	/**
	 * Every occurrence in one file, fetched once per opened file so a hover
	 * is a purely local lookup against the response rather than a round trip
	 * per token — that's the whole reason this is shaped per-file instead of
	 * per-position. Empty (not an error) for a file with no TypeScript symbols
	 * or no tsconfig project above it. A server spawn/initialize or request
	 * failure is `INTERNAL_SERVER_ERROR`, so a transient LSP failure is
	 * distinguishable from a genuine empty result and can be retried by the
	 * caller.
	 */
	fileOccurrences: oc
		.input(Schema.Struct({ sessionId: Schema.String, path: Schema.String }))
		.output(Schema.Array(CodeIndexOccurrence))
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
	/**
	 * `symbolKey` is always one echoed back by a prior `fileOccurrences`
	 * call. A malformed key, or a key whose file has no tsconfig project above
	 * it, produces an empty result because there is no symbol to resolve. A
	 * server spawn/initialize or request failure is `INTERNAL_SERVER_ERROR`,
	 * rather than an empty plan that could be cached as a successful lookup.
	 */
	references: oc
		.input(
			Schema.Struct({ sessionId: Schema.String, symbolKey: Schema.String }),
		)
		.output(CodeIndexReferencesResult)
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
	/**
	 * Returns the padded source window for one reference row. The sidecar reads
	 * the current worktree on demand, so the references list stays small and a
	 * preview failure can be retried independently of the LSP references call.
	 * A path or line that no longer exists returns `null`; an actual read failure
	 * is `INTERNAL_SERVER_ERROR`.
	 */
	referenceContext: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				path: Schema.String,
				line: Schema.Number,
			}),
		)
		.output(Schema.NullOr(CodeIndexSourceContext))
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
};
