import { type Hunk, parseHunks } from "@repo/git";
import type { ReferenceBlock } from "./schema.ts";

/** 1-based inclusive line range. */
export type LineRange = {
	readonly startLine: number;
	readonly endLine: number;
};

const closeRun = (
	ranges: ReadonlyArray<LineRange>,
	runStart: number | undefined,
	lineNumber: number,
): ReadonlyArray<LineRange> =>
	runStart === undefined
		? ranges
		: [...ranges, { startLine: runStart, endLine: lineNumber - 1 }];

const rangesForHunk = (hunk: Hunk): ReadonlyArray<LineRange> => {
	const final = hunk.lines.reduce(
		(acc, line) => {
			const marker = line[0];
			if (marker === "+") {
				return {
					ranges: acc.ranges,
					runStart: acc.runStart ?? acc.lineNumber,
					lineNumber: acc.lineNumber + 1,
				};
			}
			// "\ No newline at end of file" — not a real line, doesn't advance anything.
			if (marker === "\\") {
				return acc;
			}
			return {
				ranges: closeRun(acc.ranges, acc.runStart, acc.lineNumber),
				runStart: undefined,
				lineNumber: marker === "-" ? acc.lineNumber : acc.lineNumber + 1,
			};
		},
		{
			ranges: [] as ReadonlyArray<LineRange>,
			runStart: undefined as number | undefined,
			lineNumber: hunk.newStart,
		},
	);
	return closeRun(final.ranges, final.runStart, final.lineNumber);
};

/**
 * Every contiguous run of added lines in `patch`, in head-file (new-side)
 * line numbers — the changed-line set a walkthrough's reference blocks must
 * fully claim. Removed lines don't count: they don't exist in the head file
 * a `Location` addresses, so a purely-deleted file naturally produces no
 * ranges and needs no coverage. Built on `@repo/git`'s hunk parser rather
 * than re-parsing the patch here.
 */
export const changedLineRanges = (patch: string): ReadonlyArray<LineRange> =>
	parseHunks(patch).flatMap(rangesForHunk);

const groupLocationsByPath = (
	references: ReadonlyArray<ReferenceBlock>,
): ReadonlyMap<string, ReadonlyArray<LineRange>> =>
	references
		.flatMap((block) => block.locations)
		.reduce((map, location) => {
			const range: LineRange = {
				startLine: location.startLine,
				endLine: location.endLine,
			};
			const existing = map.get(location.path);
			map.set(
				location.path,
				existing === undefined ? [range] : [...existing, range],
			);
			return map;
		}, new Map<string, ReadonlyArray<LineRange>>());

/** The portions of `target` not covered by any range in `covering`. */
const subtractCoveredRanges = (
	target: LineRange,
	covering: ReadonlyArray<LineRange>,
): ReadonlyArray<LineRange> => {
	const sorted = [...covering].sort((a, b) => a.startLine - b.startLine);
	const final = sorted.reduce(
		(acc, range) => {
			if (acc.cursor > target.endLine || range.endLine < acc.cursor) return acc;
			if (range.startLine > target.endLine) return acc;
			const gaps =
				range.startLine > acc.cursor
					? [
							...acc.gaps,
							{
								startLine: acc.cursor,
								endLine: Math.min(range.startLine - 1, target.endLine),
							},
						]
					: acc.gaps;
			return { gaps, cursor: Math.max(acc.cursor, range.endLine + 1) };
		},
		{ gaps: [] as ReadonlyArray<LineRange>, cursor: target.startLine },
	);
	return final.cursor <= target.endLine
		? [...final.gaps, { startLine: final.cursor, endLine: target.endLine }]
		: final.gaps;
};

export type CoverageGap = {
	readonly path: string;
	readonly missingRanges: ReadonlyArray<LineRange>;
};

export type CoverageResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly gaps: ReadonlyArray<CoverageGap> };

/**
 * Every changed line in every changed file must be claimed by at least one
 * reference block's `locations` — the check that matters most: it's what
 * stops a claim-free walkthrough, or one that silently drops a file, from
 * passing.
 */
export const validateCoverage = (
	changedLineRangesByPath: ReadonlyMap<string, ReadonlyArray<LineRange>>,
	references: ReadonlyArray<ReferenceBlock>,
): CoverageResult => {
	const coveredByPath = groupLocationsByPath(references);

	const gaps = [...changedLineRangesByPath.entries()].flatMap(
		([path, changedRanges]): ReadonlyArray<CoverageGap> => {
			const missingRanges = changedRanges.flatMap((range) =>
				subtractCoveredRanges(range, coveredByPath.get(path) ?? []),
			);
			return missingRanges.length > 0 ? [{ path, missingRanges }] : [];
		},
	);

	return gaps.length === 0 ? { ok: true } : { ok: false, gaps };
};

const formatRange = (range: LineRange): string =>
	range.startLine === range.endLine
		? `line ${range.startLine}`
		: `lines ${range.startLine}-${range.endLine}`;

/** Precisely what's missing — which files, which ranges — so the agent can append a covering block rather than restart. */
export const formatCoverageFeedback = (
	gaps: ReadonlyArray<CoverageGap>,
): string =>
	[
		"Coverage is incomplete. Every changed line in every changed file must be claimed by at least one reference block's locations. These changed lines aren't covered yet:",
		"",
		...gaps.map(
			(gap) =>
				`- ${gap.path}: ${gap.missingRanges.map(formatRange).join(", ")}`,
		),
		"",
		"Add a reference block (or extend an existing one) covering each range above — append, don't restart.",
	].join("\n");
