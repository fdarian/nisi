/**
 * Synthesizes a unified diff containing only the hunks (or hunk slices)
 * overlapping a reference block's target locations in one file — keeps only
 * what's inside a given location and drops everything unmatched. See
 * `diff-hunk-slicing.ts` for why this stays at the unified-diff level instead
 * of slicing file contents directly — the `@@` header is what carries the
 * real numbering.
 */
import {
	groupIntoRuns,
	parsePatchHunks,
	resolveLineDispositions,
	serializeSubHunk,
} from "#/lib/diff-hunk-slicing";

export type LineRange = { startLine: number; endLine: number };

/** `undefined` when none of `ranges` overlap any head line the patch actually touches — nothing to show for this file (e.g. it's changed enough since generation that the referenced lines no longer exist). */
export function buildLocationFileDiff(
	patch: string,
	ranges: readonly LineRange[],
): string | undefined {
	const { preamble, hunks } = parsePatchHunks(patch);

	const keptSubHunks = hunks.flatMap((hunk) => {
		const dispositions = resolveLineDispositions(
			hunk.lines,
			(headLine) =>
				ranges.some(
					(range) => headLine >= range.startLine && headLine <= range.endLine,
				)
					? "keep"
					: "drop",
			"drop", // a hunk with no head line at all can't belong to any location
		);
		return groupIntoRuns(hunk.lines, dispositions)
			.filter((segment) => segment.disposition === "keep")
			.map(serializeSubHunk);
	});

	if (keptSubHunks.length === 0) return undefined;
	return [preamble, ...keptSubHunks].join("\n");
}
