import { parseDiffFromFile } from "@pierre/diffs";

type HeadRange = { startLine: number; endLine: number };

const linesOf = (content: string): string[] =>
	content === "" ? [] : content.replace(/\n$/, "").split("\n");

export function optimisticRangeBaseline(
	baseline: string,
	head: string,
	range: HeadRange,
): string {
	if (baseline === head) return baseline;
	const diff = parseDiffFromFile(
		{ name: "before", contents: baseline },
		{ name: "after", contents: head },
	);
	if (diff === undefined) return baseline;
	const oldLines = linesOf(baseline);
	const headLines = linesOf(head);
	const addedLines = new Set<number>();
	for (const hunk of diff.hunks) {
		let headLine = hunk.additionStart;
		for (const part of hunk.hunkContent) {
			if (part.type === "context") {
				headLine += part.lines;
			} else {
				for (let index = 0; index < part.additions; index++) {
					addedLines.add(headLine + index);
				}
				headLine += part.additions;
			}
		}
	}
	const covered = (line: number): boolean =>
		line >= 1 &&
		line <= headLines.length &&
		((line >= range.startLine && line <= range.endLine) ||
			!addedLines.has(line));
	const claimed = (line: number): boolean =>
		line >= range.startLine && line <= range.endLine;
	const result: string[] = [];
	let oldCursor = 0;
	for (const hunk of diff.hunks) {
		const oldStart =
			hunk.deletionCount === 0 ? hunk.deletionStart : hunk.deletionStart - 1;
		result.push(...oldLines.slice(oldCursor, oldStart));
		let oldLine = oldStart;
		let headLine =
			hunk.additionCount === 0 ? hunk.additionStart : hunk.additionStart - 1;
		for (const part of hunk.hunkContent) {
			if (part.type === "context") {
				result.push(...oldLines.slice(oldLine, oldLine + part.lines));
				oldLine += part.lines;
				headLine += part.lines;
				continue;
			}
			if (
				part.deletions > 0 &&
				!(
					covered(headLine) &&
					covered(headLine + 1) &&
					(claimed(headLine) || claimed(headLine + 1))
				)
			) {
				result.push(...oldLines.slice(oldLine, oldLine + part.deletions));
			}
			oldLine += part.deletions;
			for (let index = 0; index < part.additions; index++) {
				const line = headLine + index + 1;
				if (line >= range.startLine && line <= range.endLine) {
					const text = headLines[line - 1];
					if (text !== undefined) result.push(text);
				}
			}
			headLine += part.additions;
		}
		oldCursor = oldLine;
	}
	result.push(...oldLines.slice(oldCursor));
	return result.length === 0
		? ""
		: `${result.join("\n")}${head.endsWith("\n") ? "\n" : ""}`;
}
