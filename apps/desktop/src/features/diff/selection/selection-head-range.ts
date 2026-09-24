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

type ResolvedEndpoint = { position: number; headLine?: number };

function hunkRowCount(hunk: FileDiffMetadata["hunks"][number]): number {
	return hunk.hunkContent.reduce(
		(count, content) =>
			count +
			(content.type === "context"
				? content.lines
				: content.deletions + content.additions),
		0,
	);
}

function resolveEndpoint(
	hunks: FileDiffMetadata["hunks"],
	rows: readonly DiffRow[],
	endpoint: SelectionEndpoint,
): ResolvedEndpoint {
	const index = rows.findIndex((row) => matchesEndpoint(row, endpoint));
	if (index >= 0) return { position: index, headLine: rows[index]?.headLine };

	let position = 0;
	let precedingOffset: number | undefined;
	for (const hunk of hunks) {
		const oldStart = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
		const headStart = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
		const sideStart = endpoint.side === "deletions" ? oldStart : headStart;
		const sideCount =
			endpoint.side === "deletions" ? hunk.deletionCount : hunk.additionCount;
		if (endpoint.line < sideStart) {
			const offset = precedingOffset ?? headStart - oldStart;
			return {
				position: position - 0.5,
				headLine:
					endpoint.side === "deletions"
						? endpoint.line + offset
						: endpoint.line,
			};
		}
		if (endpoint.line < sideStart + sideCount) {
			throw new Error(
				"Selection endpoint lies within a hunk but has no matching row",
			);
		}
		position += hunkRowCount(hunk);
		precedingOffset =
			headStart + hunk.additionCount - (oldStart + hunk.deletionCount);
	}
	return {
		position: position - 0.5,
		headLine:
			endpoint.side === "deletions"
				? endpoint.line + (precedingOffset ?? 0)
				: endpoint.line,
	};
}

/** Include an unselected flank only when it is unchanged context directly beside a selected deletion. */
export function selectionHeadRange(
	hunks: FileDiffMetadata["hunks"],
	start: SelectionEndpoint,
	end: SelectionEndpoint,
): HeadRange | undefined {
	const rows = diffRows(hunks);
	const startPoint = resolveEndpoint(hunks, rows, start);
	const endPoint = resolveEndpoint(hunks, rows, end);
	const first = Math.ceil(Math.min(startPoint.position, endPoint.position));
	const last = Math.floor(Math.max(startPoint.position, endPoint.position));
	let startLine = Math.min(
		startPoint.headLine ?? Number.POSITIVE_INFINITY,
		endPoint.headLine ?? Number.POSITIVE_INFINITY,
	);
	let endLine = Math.max(
		startPoint.headLine ?? Number.NEGATIVE_INFINITY,
		endPoint.headLine ?? Number.NEGATIVE_INFINITY,
	);
	for (let index = first; index <= last; index++) {
		const line = rows[index]?.headLine;
		if (line === undefined) continue;
		startLine = Math.min(startLine, line);
		endLine = Math.max(endLine, line);
	}
	if (startLine === Number.POSITIVE_INFINITY) return undefined;
	if (startPoint.position === first || endPoint.position === first) {
		if (
			rows[first]?.kind === "deletion" &&
			rows[first - 1]?.kind === "context"
		) {
			const flank = rows[first - 1]?.headLine;
			if (flank === startLine - 1) startLine = flank;
		}
	}
	if (startPoint.position === last || endPoint.position === last) {
		if (rows[last]?.kind === "deletion" && rows[last + 1]?.kind === "context") {
			const flank = rows[last + 1]?.headLine;
			if (flank === endLine + 1) endLine = flank;
		}
	}
	return { startLine, endLine };
}
