/**
 * Slices a file's `base → head` unified patch down to only the head-line
 * spans `FileContentReview.ranges` marks `"new"`, dropping the `"reviewed"`
 * ones — the collapse behind a marker Phase 2's diff pane renders. Pure text
 * surgery built on `diff-hunk-slicing.ts`'s shared parse/slice primitives —
 * same mechanism PLAN.md's "Neither lib can render an arbitrary line-range
 * subset" constraint describes for Phase 3's reference blocks
 * (`build-location-diff.ts`), just with the opposite keep/drop policy: here
 * a *matched* "reviewed" range is what gets dropped, and anything unmatched
 * defaults to kept (not yet reviewed).
 *
 * `ranges` can subdivide *within* one `base → head` hunk — `@repo/review`'s
 * `reconcile()` overlays `diff(reviewed, head)` on top of it — so slicing
 * happens per line, not per hunk.
 *
 * This is an independent pure computation — no React, no `itemMetadata`, no
 * `forcedPaths` — so it lives outside `diff-pane.tsx` on its own.
 */
import {
	type AnnotatedLine,
	groupIntoRuns,
	type LineDisposition,
	parsePatchHunks,
	type RunSegment,
	resolveLineDispositions,
	serializeSubHunk,
} from "#/lib/diff-hunk-slicing";
import type { ReviewRange } from "#/lib/pr-data";

/** A run of collapsed lines the diff pane renders as a clickable marker. */
export type CollapsedGap = {
	/**
	 * Head line the marker attaches above (`side: "additions"`). `null` when
	 * nothing kept surfaces anywhere later in the file, so the caller renders
	 * it file-level (`lineNumber: 0`) instead.
	 */
	anchorLine: number | null;
	lineCount: number;
};

export type CollapsedFileDiff =
	/** Some hunks (or hunk slices) survive — `patch` is a valid standalone unified diff. */
	| { kind: "partial"; patch: string; gaps: readonly CollapsedGap[] }
	/** Every line collapsed — nothing left to render as a diff at all. */
	| { kind: "full"; lineCount: number };

function dispositionForHeadLine(
	headLine: number,
	ranges: readonly ReviewRange[],
): LineDisposition {
	const range = ranges.find(
		(candidate) =>
			headLine >= candidate.startLine && headLine <= candidate.endLine,
	);
	return range?.status === "reviewed" ? "drop" : "keep";
}

function firstKeptHeadLine(
	segments: readonly RunSegment[],
	fromIndex: number,
): number | null {
	for (let index = fromIndex; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === undefined || segment.disposition !== "keep") continue;
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
			(headLine) => dispositionForHeadLine(headLine, ranges),
			"keep", // a hunk with no head line at all is never collapsed
		);
		return groupIntoRuns(hunk.lines, dispositions);
	});

	const keptSubHunks = segments
		.filter((segment) => segment.disposition === "keep")
		.map(serializeSubHunk);

	if (keptSubHunks.length === 0) {
		const lineCount = ranges
			.filter((range) => range.status === "reviewed")
			.reduce((sum, range) => sum + (range.endLine - range.startLine + 1), 0);
		return { kind: "full", lineCount };
	}

	const gaps = segments.reduce<CollapsedGap[]>((acc, segment, index) => {
		if (segment.disposition !== "drop") return acc;
		const lineCount = segment.lines.filter(
			(line: AnnotatedLine) => line.headLine !== null,
		).length;
		if (lineCount === 0) return acc;
		acc.push({ anchorLine: firstKeptHeadLine(segments, index + 1), lineCount });
		return acc;
	}, []);

	const keptSegmentsInOrder = segments.filter(
		(segment) => segment.disposition === "keep",
	);
	const patchText = [
		preamble,
		...keptSegmentsInOrder.map(serializeSubHunk),
	].join("\n");

	return { kind: "partial", patch: patchText, gaps };
}
