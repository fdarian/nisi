import type { FileDiffMetadata, SelectionSide } from "@pierre/diffs";

export type HeadRange = { startLine: number; endLine: number };
export type SelectionEndpoint = { line: number; side: SelectionSide };

type DiffRow = {
	oldLine?: number;
	headLine?: number;
	kind: "context" | "addition" | "deletion";
};

function diffRows(hunks: FileDiffMetadata["hunks"]): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const hunk of hunks) {
		let oldLine = hunk.deletionStart;
		let headLine = hunk.additionStart;
		for (const content of hunk.hunkContent) {
			if (content.type === "context") {
				for (let index = 0; index < content.lines; index++) {
					rows.push({
						oldLine: oldLine++,
						headLine: headLine++,
						kind: "context",
					});
				}
			} else {
				for (let index = 0; index < content.deletions; index++) {
					rows.push({ oldLine: oldLine++, kind: "deletion" });
				}
				for (let index = 0; index < content.additions; index++) {
					rows.push({ headLine: headLine++, kind: "addition" });
				}
			}
		}
	}
	return rows;
}

function matchesEndpoint(row: DiffRow, endpoint: SelectionEndpoint): boolean {
	return endpoint.side === "deletions"
		? row.oldLine === endpoint.line
		: row.headLine === endpoint.line;
}

/** Include an unselected flank only when it is unchanged context directly beside a selected deletion. */
export function selectionHeadRange(
	hunks: FileDiffMetadata["hunks"],
	start: SelectionEndpoint,
	end: SelectionEndpoint,
): HeadRange | undefined {
	const rows = diffRows(hunks);
	const startIndex = rows.findIndex((row) => matchesEndpoint(row, start));
	const endIndex = rows.findIndex((row) => matchesEndpoint(row, end));
	if (startIndex < 0 || endIndex < 0) return undefined;
	const first = Math.min(startIndex, endIndex);
	const last = Math.max(startIndex, endIndex);
	let startLine = Number.POSITIVE_INFINITY;
	let endLine = Number.NEGATIVE_INFINITY;
	for (let index = first; index <= last; index++) {
		const line = rows[index]?.headLine;
		if (line === undefined) continue;
		startLine = Math.min(startLine, line);
		endLine = Math.max(endLine, line);
	}
	if (startLine === Number.POSITIVE_INFINITY) return undefined;
	if (rows[first]?.kind === "deletion" && rows[first - 1]?.kind === "context") {
		const flank = rows[first - 1]?.headLine;
		if (flank === startLine - 1) startLine = flank;
	}
	if (rows[last]?.kind === "deletion" && rows[last + 1]?.kind === "context") {
		const flank = rows[last + 1]?.headLine;
		if (flank === endLine + 1) endLine = flank;
	}
	return { startLine, endLine };
}
