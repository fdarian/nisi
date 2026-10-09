import type { FileContentReview } from "#/features/pull-request/data/pr-data";
import type { LineRange } from "./viewer/build-location-diff";

/** How much of a set of line ranges is reviewed: drives a checkbox's checked/indeterminate state. */
export type RangeReviewStatus = "reviewed" | "partial" | "unreviewed";

/**
 * How much of `targetRanges` is reviewed, counted over the lines the diff
 * actually has: `review.ranges` partitions the changed lines of `base → head`
 * into disjoint `"reviewed"`/`"new"` runs, so a target's unchanged lines (the
 * context a Ref's range tends to include) belong to no run and count toward
 * neither side. Counting them as unreviewed would leave a fully ticked range
 * "partial" for good. Interval overlap, not a line-by-line walk, since a
 * location can span hundreds of lines.
 */
export function rangeReviewStatus(
	targetRanges: readonly LineRange[],
	review: FileContentReview | null | undefined,
): RangeReviewStatus {
	if (review == null) return "unreviewed";
	let changedLines = 0;
	let reviewedLines = 0;
	for (const target of targetRanges) {
		for (const range of review.ranges) {
			const overlapStart = Math.max(target.startLine, range.startLine);
			const overlapEnd = Math.min(target.endLine, range.endLine);
			if (overlapStart > overlapEnd) continue;
			const lines = overlapEnd - overlapStart + 1;
			changedLines += lines;
			if (range.status === "reviewed") reviewedLines += lines;
		}
	}
	if (reviewedLines <= 0) return "unreviewed";
	if (reviewedLines >= changedLines) return "reviewed";
	return "partial";
}

/** What currently vouches for the reviewed lines inside `target`: the distinct range-claim block ids, and whether the whole-file claim is one of them. */
export function claimsOverlapping(
	target: LineRange,
	review: FileContentReview | null | undefined,
): { blocks: { blockId: string; blockLabel: string }[]; wholeFile: boolean } {
	const blocks = new Map<string, string>();
	let wholeFile = false;
	for (const range of review?.ranges ?? []) {
		if (range.status !== "reviewed" || range.reviewedVia === null) continue;
		if (range.startLine > target.endLine || range.endLine < target.startLine) {
			continue;
		}
		if (range.reviewedVia.kind === "file") wholeFile = true;
		else blocks.set(range.reviewedVia.blockId, range.reviewedVia.blockLabel);
	}
	return {
		blocks: [...blocks].map(([blockId, blockLabel]) => ({
			blockId,
			blockLabel,
		})),
		wholeFile,
	};
}
