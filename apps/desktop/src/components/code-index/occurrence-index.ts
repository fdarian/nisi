/**
 * Turns one file's flat `codeIndex.fileOccurrences` response into a
 * by-line lookup a token hover can query synchronously — the whole reason
 * `fileOccurrences` is fetched once per file rather than once per position
 * (see that procedure's own doc comment in `packages/sidecar-api/src/code-index.ts`).
 *
 * Coordinate conversion happens once, here, at index-build time rather than
 * at every lookup: SCIP occurrences are 0-based for both line and character,
 * half-open on the character range (`[charStart, charEnd)`); `@pierre/diffs`
 * token events report a 1-based `lineNumber`. Getting this wrong is the
 * single most likely way to silently underline the wrong token, so it's
 * centralized in one place (`buildOccurrenceIndex`) instead of repeated at
 * every call site that needs it.
 */
import type { CodeIndexOccurrence } from "@repo/sidecar-api";

export type OccurrenceIndex = ReadonlyMap<
	number,
	readonly CodeIndexOccurrence[]
>;

/** `occurrence.line` (SCIP, 0-based) keyed as `line + 1` — `@pierre/diffs`' own 1-based `TokenEventBase.lineNumber`. */
export function buildOccurrenceIndex(
	occurrences: readonly CodeIndexOccurrence[],
): OccurrenceIndex {
	const byLine = new Map<number, CodeIndexOccurrence[]>();
	for (const occurrence of occurrences) {
		const codeViewLine = occurrence.line + 1;
		const existing = byLine.get(codeViewLine);
		if (existing !== undefined) existing.push(occurrence);
		else byLine.set(codeViewLine, [occurrence]);
	}
	return byLine;
}

/**
 * Resolves the occurrence (if any) a hovered/clicked token corresponds to.
 * `lineNumber` is `@pierre/diffs`' 1-based line; `charStart`/`charEnd` are
 * its token's character range, in the same 0-based/half-open coordinate
 * space SCIP uses (both describe offsets into the same line's plain text),
 * so no further conversion is needed for the character comparison.
 *
 * Tries an exact range match first (the common case: a Shiki token and a
 * SCIP occurrence agree on where an identifier starts/ends), falling back to
 * containment (the occurrence's range fully covers the token's) for the rare
 * case where tokenization splits a symbol differently than SCIP's range —
 * e.g. a token boundary landing mid-identifier for some highlighter
 * grammars. Ignores an occurrence the token only partially overlaps, since a
 * partial overlap means the token and the occurrence disagree about where
 * the symbol actually is — safer to show no affordance than a wrong one.
 */
export function findOccurrenceForToken(
	index: OccurrenceIndex,
	lineNumber: number,
	charStart: number,
	charEnd: number,
): CodeIndexOccurrence | undefined {
	const candidates = index.get(lineNumber);
	if (candidates === undefined) return undefined;
	const exact = candidates.find(
		(occurrence) =>
			occurrence.charStart === charStart && occurrence.charEnd === charEnd,
	);
	if (exact !== undefined) return exact;
	return candidates.find(
		(occurrence) =>
			occurrence.charStart <= charStart && charEnd <= occurrence.charEnd,
	);
}
