/**
 * One run of changed lines in a file's head, as a reader would call a hunk: a
 * stretch of added and/or removed lines with unchanged lines (or the file's
 * edge) on both sides. Unlike a unified diff's own `@@` hunks, runs never
 * include context, so they come out the same whatever `-U<n>` made the patch.
 */
export type ChangedRun = {
	/** 1-based, head side. A pure removal sits on the line it was removed before. */
	readonly startLine: number;
	readonly endLine: number;
	readonly additions: number;
	readonly deletions: number;
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export const parseChangedRuns = (patch: string): ChangedRun[] => {
	const runs: ChangedRun[] = [];
	let newLine = 0;
	let inHunk = false;
	let run: { start: number; end: number; add: number; del: number } | null =
		null;
	const close = () => {
		if (run !== null) {
			runs.push({
				startLine: run.start,
				endLine: run.end,
				additions: run.add,
				deletions: run.del,
			});
			run = null;
		}
	};
	for (const line of patch.split("\n")) {
		const header = HUNK_HEADER.exec(line);
		if (header !== null) {
			close();
			newLine = Number.parseInt(header[1] as string, 10);
			inHunk = true;
			continue;
		}
		if (line.startsWith("diff --git ")) {
			close();
			inHunk = false;
			continue;
		}
		if (!inHunk) continue;
		const marker = line[0];
		if (marker === "+") {
			run ??= { start: newLine, end: newLine, add: 0, del: 0 };
			run.add += 1;
			run.end = newLine;
			newLine += 1;
		} else if (marker === "-") {
			run ??= { start: newLine, end: newLine, add: 0, del: 0 };
			run.del += 1;
		} else if (marker === " ") {
			close();
			newLine += 1;
		}
	}
	close();
	return runs;
};
