import type { SelectionSide } from "@pierre/diffs";

export type HeadRange = { startLine: number; endLine: number };

/** A mixed selection includes the adjacent HEAD lines because reconciliation only hides a deletion when both flanks have review coverage. */
export function selectionHeadRange(
	rows: Iterable<{ line: number; side: SelectionSide }>,
	fileEndLine?: number,
): HeadRange | undefined {
	let startLine = Number.POSITIVE_INFINITY;
	let endLine = Number.NEGATIVE_INFINITY;
	let includesDeletion = false;
	for (const row of rows) {
		if (row.side === "deletions") {
			includesDeletion = true;
			continue;
		}
		startLine = Math.min(startLine, row.line);
		endLine = Math.max(endLine, row.line);
	}
	return startLine === Number.POSITIVE_INFINITY
		? undefined
		: {
				startLine: includesDeletion ? Math.max(1, startLine - 1) : startLine,
				endLine:
					includesDeletion && fileEndLine !== undefined
						? Math.min(fileEndLine, endLine + 1)
						: endLine,
			};
}
