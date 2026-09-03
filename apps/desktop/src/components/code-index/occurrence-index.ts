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
 * Overlap, not containment either direction, is the right test — confirmed
 * live against real rendered output: Shiki merges a leading run of
 * whitespace/punctuation into the *same* span as an adjacent identifier
 * (`"  ConfigField,"` renders as one token, two leading spaces and all), so
 * a token's range can be *wider* than the occurrence it corresponds to, not
 * only narrower (a token boundary landing mid-identifier, the case this used
 * to handle via one-directional containment). An earlier version tried exact
 * match then "occurrence contains token" — both fail outright for a
 * whitespace-merged token, since the occurrence is narrower than the token
 * in exactly that case. Picking the candidate with the *largest* overlap
 * (rather than the first one that overlaps at all) is what makes this safe
 * when a merged token's padding happens to abut a second, unrelated
 * occurrence on the same line — e.g. two adjacent short identifiers
 * separated only by punctuation the tokenizer folded into one of them.
 */
export function findOccurrenceForToken(
	index: OccurrenceIndex,
	lineNumber: number,
	charStart: number,
	charEnd: number,
): CodeIndexOccurrence | undefined {
	const candidates = index.get(lineNumber);
	if (candidates === undefined) return undefined;

	let best: CodeIndexOccurrence | undefined;
	let bestOverlap = 0;
	for (const occurrence of candidates) {
		const overlapStart = Math.max(occurrence.charStart, charStart);
		const overlapEnd = Math.min(occurrence.charEnd, charEnd);
		const overlap = overlapEnd - overlapStart;
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			best = occurrence;
		}
	}
	return best;
}
