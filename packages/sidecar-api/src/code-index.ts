import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * `status`'s outcome, five mutually exclusive states rather than a
 * boolean-plus-flags pile, since the UI needs to render a genuinely
 * different affordance for each. Backed by a live `tsc --lsp --stdio`
 * process per tsconfig project (`@repo/code-lsp`), not a static on-disk
 * index — see `apps/desktop/sidecar/code-index/state.ts` for the exact
 * derivation. `unsupported` — no `tsconfig.json` anywhere in the repo, so
 * there's no project for a server to spawn against at all (no build button);
 * `absent` — supported, but `build` has never been called this session (a
 * "build index" prompt); `building` — a `build` call is spawning/
 * initializing a server (a spinner, no new `build` needed); `ready` — that
 * spawn/initialize last succeeded; `failed` — it last failed (a binary
 * resolution or process-spawn problem — see `describeBuildFailure`).
 * There is no `"stale"` state: that existed only for a static index that
 * could disagree with a repo that moved past the head it was built for — a
 * live server has no such staleness to report, since it answers every query
 * by reading the file straight off disk at query time (see
 * `CodeIndexReference.lineText`'s own doc comment below). Dropped outright
 * rather than kept unreachable, since nothing on either side of the wire
 * could ever emit or need to match it.
 */
export const CodeIndexStatusKind = Schema.Literals([
	"unsupported",
	"absent",
	"building",
	"ready",
	"failed",
]);
export type CodeIndexStatusKind = Schema.Schema.Type<
	typeof CodeIndexStatusKind
>;

/**
 * `indexedHeadSha`/`generatedAt` describe the last successful `build` for
 * this repo's primary tsconfig project, if any — both `null` for
 * `unsupported`/`absent`/`failed` (nothing has ever succeeded to describe;
 * see `apps/desktop/sidecar/code-index/state.ts`'s `buildStates`, which
 * doesn't retain a prior success once a later `build` fails, unlike the old
 * on-disk cache this replaced). `indexedHeadSha` mirrors `headSha` exactly
 * whenever it's populated — there's no separate index revision to disagree
 * with it anymore, since a live server always answers against whatever's on
 * disk right now, not a snapshot taken at some earlier head. `documentCount`
 * is always `null` — the LSP server has no "how many files does this cover"
 * concept to report; every query is scoped to one file or one symbol, never
 * the whole project. `failureMessage` is populated only for `failed`.
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

/**
 * One reference occurrence plus its source line's text — carried here rather
 * than making the frontend fetch each file separately, since the peek
 * preview needs to render immediately for every entry in the list.
 *
 * `lineText` is `null` only when the sidecar genuinely couldn't read it —
 * the file is gone, or the recorded line no longer exists in a file that
 * got shorter (`apps/desktop/sidecar/code-index/state.ts`'s
 * `groupReferencesByFile`). There's no drift case to guard against anymore:
 * the LSP server that produced this location and the worktree read that
 * produced `lineText` both read the same live file off disk, at query time —
 * unlike the SCIP index this replaced, which was built once and could
 * silently disagree with a file edited afterward. See `CodeIndexStatus`'s
 * own doc comment on why `"stale"` is retired for the same reason.
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
 * A window of source lines around `CodeIndexReferencesResult.definition` —
 * `lines[0]` is `startLine` (0-based), so the definition's own line is
 * `lines[definition.line - startLine]`. Carried here rather than making the
 * frontend fetch the whole file itself: a separate `file.get` call reads
 * through `Store.readCurrentContent`'s `includeUncommitted` gate, which is a
 * *diff-scoping* preference with no authority over what the LSP server's
 * positions mean — it always reads the working tree, so a preview read any
 * other way could describe a different revision than the one `definition`'s
 * position was resolved against. This field is always read the same
 * worktree-unconditional way `CodeIndexReference.lineText` is (`@repo/git`'s
 * `readWorktreeBlobContent`, via `readWorktreeFileContents` in
 * `apps/desktop/sidecar/code-index/state.ts`), so both halves of a peek
 * agree on their source. `null` only when there's no `definition` at all,
 * or its file couldn't be read — see `CodeIndexReferencesResult`'s own doc
 * comment.
 */
export const CodeIndexSourceContext = Schema.Struct({
	startLine: Schema.Number,
	lines: Schema.Array(Schema.String),
});
export type CodeIndexSourceContext = Schema.Schema.Type<
	typeof CodeIndexSourceContext
>;

/**
 * `returnedReferenceCount` vs. `totalReferenceCount` is what lets the UI
 * render "showing N of M" rather than silently truncating — the sidecar
 * caps how many reference locations a single call returns (see
 * `apps/desktop/sidecar/code-index/state.ts`), since a widely-referenced
 * symbol (an exported type, a common utility) can have thousands.
 *
 * `definitionContext` is `null` both when there's no `definition` to begin
 * with and when there is one but its file couldn't be read — same "no
 * reliable preview" meaning `CodeIndexReference.lineText: null` carries;
 * `definition` itself stays populated either way; only the *text* preview
 * is withheld.
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
	 * A pure read — safe to call on every mount/tab-focus. Never builds
	 * anything itself; the frontend calls `build` separately and polls this
	 * to watch progress, the same "read vs. act" split as
	 * `walkthrough.activeGeneration` vs. `walkthrough.generate`.
	 */
	status: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(CodeIndexStatus)
		.errors({ NOT_FOUND: {}, INTERNAL_SERVER_ERROR: {} }),
	/**
	 * Spawns/initializes a `tsc --lsp --stdio` server for `sessionId`'s
	 * repo's primary tsconfig project and returns immediately — `status` is
	 * what reports progress. A second `build` call while one's already
	 * running for this repo is a no-op, not an error: the existing attempt
	 * keeps going and the caller just polls the same `status` every other
	 * caller would. Not a streaming procedure on purpose — a cold spawn plus
	 * `initialize` is on the order of tens of milliseconds (measured against
	 * `@repo/code-lsp`), cheap enough polled once a second that it doesn't
	 * earn the `eventIterator`/async-generator handler shape
	 * `walkthrough.generate` needs for genuinely live, multi-event progress.
	 * `fileOccurrences`/`references` don't depend on
	 * this having been called at all — each spawns its own project's server
	 * lazily on first use regardless (see
	 * `apps/desktop/sidecar/code-index/state.ts`) — `build` only exists to
	 * give the UI something to show progress against and to keep one
	 * concrete project warm ahead of time.
	 */
	build: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Void)
		.errors({
			NOT_FOUND: {},
			UNSUPPORTED: {},
			INTERNAL_SERVER_ERROR: {},
		}),
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
};
