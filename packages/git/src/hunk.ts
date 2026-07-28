/**
 * One `@@ -oldStart,oldLines +newStart,newLines @@` region of a unified diff.
 * `lines` keeps each body line's leading `+`/`-`/` ` marker intact — Phase 2's
 * reconciliation (`diff(reviewed, head)`) works off exactly this shape.
 */
export type Hunk = {
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	/** The full `@@ ... @@` header line, including any trailing function context. */
	readonly header: string;
	readonly lines: ReadonlyArray<string>;
};

// A line count is omitted from the header when it's exactly 1.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/;

/** Parses every hunk out of one file's unified diff (patch, not the `diff --git` file header). */
export const parseHunks = (patch: string): ReadonlyArray<Hunk> => {
	const lines = patch.split("\n");
	const hunks: Array<{
		header: string;
		oldStart: number;
		oldLines: number;
		newStart: number;
		newLines: number;
		lines: Array<string>;
	}> = [];

	for (const line of lines) {
		const match = HUNK_HEADER.exec(line);
		if (match !== null) {
			hunks.push({
				header: line,
				oldStart: Number(match[1]),
				oldLines: match[2] === undefined ? 1 : Number(match[2]),
				newStart: Number(match[3]),
				newLines: match[4] === undefined ? 1 : Number(match[4]),
				lines: [],
			});
			continue;
		}
		hunks.at(-1)?.lines.push(line);
	}

	// `patch.split("\n")` on a trailing-newline-terminated patch yields one
	// final empty string that isn't a real body line — drop it from whichever
	// hunk picked it up (only ever the last one).
	const lastHunk = hunks.at(-1);
	if (lastHunk !== undefined && lastHunk.lines.at(-1) === "") {
		lastHunk.lines.pop();
	}

	return hunks;
};
