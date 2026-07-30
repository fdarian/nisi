/**
 * Slices a file's `base → head` unified patch down to only the head-line
 * spans `FileContentReview.ranges` marks `"new"`, dropping the `"reviewed"`
 * ones — the collapse behind a marker the diff pane renders. Pure text
 * surgery built on `diff-hunk-slicing.ts`'s shared parse/slice primitives
 * (see that file for why this can't just slice file contents directly).
 * `build-location-diff.ts` uses the same mechanism for reference blocks,
 * just with the opposite keep/drop policy: here a *matched* "reviewed"
 * range is what gets dropped, and anything unmatched defaults to kept (not
 * yet reviewed).
 *
 * `ranges` can subdivide *within* one `base → head` hunk — `@repo/review`'s
 * `reconcile()` overlays `diff(reviewed, head)` on top of it — so slicing
 * happens per line, not per hunk. There's a second reason to subdivide:
 * two adjacent "reviewed" lines attributed to different claims (the
 * whole-file checkbox vs. a walkthrough block, or two different blocks)
 * render as two separate collapsed runs, not one — grouping keys on
 * `reviewedVia` (encoded as a plain disposition string so the shared
 * `groupIntoRuns` primitive still just compares by `===`), not merely
 * keep/drop.
 *
 * This is an independent pure computation — no React, no `itemMetadata`, no
 * `forcedPaths` — so it lives outside `diff-pane.tsx` on its own.
 */
import {
	type AnnotatedLine,
	groupIntoRuns,
	parsePatchHunks,
	type RunSegment,
	resolveLineDispositions,
	serializeSubHunk,
} from "#/lib/diff-hunk-slicing";
import type { ReviewRange, ReviewSource } from "#/lib/pr-data";

const KEEP = "keep";

/** A run of collapsed lines the diff pane renders as a clickable marker. */
export type CollapsedGap = {
	/**
	 * Head line the marker attaches above (`side: "additions"`). `null` when
	 * nothing kept surfaces anywhere later in the file, so the caller renders
	 * it file-level (`lineNumber: 0`) instead.
	 */
	anchorLine: number | null;
	lineCount: number;
	/** Which claim vouches for every line in this run — uniform by construction, see the module doc. */
	source: ReviewSource;
};

export type CollapsedFileDiff =
	/** Some hunks (or hunk slices) survive — `patch` is a valid standalone unified diff. */
	| { kind: "partial"; patch: string; gaps: readonly CollapsedGap[] }
	/** Every line collapsed — nothing left to render as a diff at all. `"mixed"` when the dropped lines came from more than one claim. */
	| { kind: "full"; lineCount: number; source: ReviewSource | "mixed" };

function reviewRangeForHeadLine(
	headLine: number,
	ranges: readonly ReviewRange[],
): ReviewRange | undefined {
	return ranges.find(
		(candidate) =>
			headLine >= candidate.startLine && headLine <= candidate.endLine,
	);
}

/** Encodes a line's grouping key — `"keep"`, or a `"drop"` variant distinct per claim, so `groupIntoRuns`' `===` check never merges two different claims' runs. */
function dispositionKey(range: ReviewRange | undefined): string {
	if (range === undefined || range.status !== "reviewed") return KEEP;
	const via = range.reviewedVia;
	if (via === null) return KEEP; // contract says this can't happen for "reviewed" — fail safe by not collapsing
	return via.kind === "file" ? "drop:file" : `drop:range:${via.blockId}`;
}

function sourceKey(source: ReviewSource): string {
	return source.kind === "file" ? "file" : `range:${source.blockId}`;
}

/** The concrete `ReviewSource` a "drop" segment was grouped under — resolved from its first head-numbered line, guaranteed present by `dispositionKey`'s construction. */
function sourceForDropSegment(
	segment: RunSegment<string>,
	ranges: readonly ReviewRange[],
): ReviewSource | undefined {
	const line = segment.lines.find((candidate) => candidate.headLine !== null);
	if (line?.headLine == null) return undefined;
	const via = reviewRangeForHeadLine(line.headLine, ranges)?.reviewedVia;
	return via ?? undefined;
}

function firstKeptHeadLine(
	segments: readonly RunSegment<string>[],
	fromIndex: number,
): number | null {
	for (let index = fromIndex; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === undefined || segment.disposition !== KEEP) continue;
		const line = segment.lines.find((candidate) => candidate.headLine !== null);
		if (line?.headLine != null) return line.headLine;
	}
	return null;
}

/**
 * Builds the collapsed rendering of one file's patch, or `undefined` when
 * `ranges` has nothing to collapse (no file has been reviewed, or every
 * range is `"new"`) — the caller renders the file normally in that case.
 */
export function buildCollapsedFileDiff(
	patch: string,
	ranges: readonly ReviewRange[],
): CollapsedFileDiff | undefined {
	if (!ranges.some((range) => range.status === "reviewed")) return undefined;

	const { preamble, hunks } = parsePatchHunks(patch);
	const segments = hunks.flatMap((hunk) => {
		const dispositions = resolveLineDispositions(
			hunk.lines,
			(headLine) => dispositionKey(reviewRangeForHeadLine(headLine, ranges)),
			KEEP, // a hunk with no head line at all is never collapsed
		);
		return groupIntoRuns(hunk.lines, dispositions);
	});

	const keptSubHunks = segments
		.filter((segment) => segment.disposition === KEEP)
		.map(serializeSubHunk);

	const dropSegments = segments.filter(
		(segment) => segment.disposition !== KEEP,
	);

	if (keptSubHunks.length === 0) {
		let lineCount = 0;
		const distinctSources = new Set<string>();
		let uniformSource: ReviewSource | undefined;
		for (const segment of dropSegments) {
			const segmentLineCount = segment.lines.filter(
				(line: AnnotatedLine) => line.headLine !== null,
			).length;
			if (segmentLineCount === 0) continue;
			lineCount += segmentLineCount;
			const source = sourceForDropSegment(segment, ranges);
			if (source === undefined) continue;
			distinctSources.add(sourceKey(source));
			uniformSource = source;
		}
		return {
			kind: "full",
			lineCount,
			source:
				distinctSources.size === 1 && uniformSource !== undefined
					? uniformSource
					: "mixed",
		};
	}

	const gaps = segments.reduce<CollapsedGap[]>((acc, segment, index) => {
		if (segment.disposition === KEEP) return acc;
		const lineCount = segment.lines.filter(
			(line: AnnotatedLine) => line.headLine !== null,
		).length;
		if (lineCount === 0) return acc;
		const source = sourceForDropSegment(segment, ranges);
		if (source === undefined) return acc; // contract violation — see dispositionKey's fail-safe
		acc.push({
			anchorLine: firstKeptHeadLine(segments, index + 1),
			lineCount,
			source,
		});
		return acc;
	}, []);

	const keptSegmentsInOrder = segments.filter(
		(segment) => segment.disposition === KEEP,
	);
	const patchText = [
		preamble,
		...keptSegmentsInOrder.map(serializeSubHunk),
	].join("\n");

	return { kind: "partial", patch: patchText, gaps };
}
