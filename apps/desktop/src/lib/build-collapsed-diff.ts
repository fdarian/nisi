/**
 * Slices a file's `base → head` unified patch down to only the head-line
 * spans `FileContentReview.ranges` marks `"new"`, dropping the `"reviewed"`
 * ones — the collapse behind a marker Phase 2's diff pane renders. Pure text
 * surgery: a kept hunk's `@@ -a,b +c,d @@` header already encodes its
 * absolute old/new line position, so omitting hunks (or slices of one)
 * around it needs no offset recalculation. Same technique PLAN.md's "Neither
 * lib can render an arbitrary line-range subset" constraint describes for
 * Phase 3's reference blocks.
 *
 * `ranges` can subdivide *within* one `base → head` hunk — `@repo/review`'s
 * `reconcile()` overlays `diff(reviewed, head)` on top of it — so slicing
 * happens per line, not per hunk. A line with no head-line number of its own
 * (a deletion, or a `\ No newline at end of file` marker) inherits the
 * nearest surrounding head line's status within its own hunk, forward first
 * then backward, mirroring how `reconcile()` anchors a pure-deletion
 * touched-interval to the head line it sits against.
 *
 * This is an independent pure computation — no React, no `itemMetadata`, no
 * `forcedPaths` — so it lives outside `diff-pane.tsx` on its own.
 */
import { HUNK_HEADER } from "@pierre/diffs";
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

type LinePrefix = " " | "+" | "-" | "\\";
type ReviewStatus = "reviewed" | "new";

type AnnotatedLine = {
	prefix: LinePrefix;
	text: string;
	/** 1-based head (new-file) line number; `null` for lines with no head-side counterpart. */
	headLine: number | null;
	oldLine: number;
	newLine: number;
};

type ParsedHunk = {
	oldStart: number;
	newStart: number;
	lines: readonly AnnotatedLine[];
};

function parseLinePrefix(rawLine: string): LinePrefix | undefined {
	const first = rawLine[0];
	if (first === " " || first === "+" || first === "-" || first === "\\") {
		return first;
	}
	return undefined;
}

/** Splits raw patch text into its preamble (`diff --git`/`---`/`+++` lines) and each `@@` hunk, tracking every line's old/new position. */
function parsePatchHunks(patch: string): {
	preamble: string;
	hunks: readonly ParsedHunk[];
} {
	const lines = patch.split("\n");
	const headerIndexes = lines.reduce<number[]>((acc, line, index) => {
		if (HUNK_HEADER.test(line)) acc.push(index);
		return acc;
	}, []);

	const preambleEnd = headerIndexes[0] ?? lines.length;
	const preamble = lines.slice(0, preambleEnd).join("\n");

	const hunks = headerIndexes.map((headerIndex, hunkIndex) => {
		const header = lines[headerIndex] ?? "";
		const match = HUNK_HEADER.exec(header);
		const oldStart = Number(match?.[1] ?? 1);
		const newStart = Number(match?.[3] ?? 1);
		const bodyEnd = headerIndexes[hunkIndex + 1] ?? lines.length;
		const bodyLines = lines.slice(headerIndex + 1, bodyEnd);

		const annotated: AnnotatedLine[] = [];
		let oldLine = oldStart;
		let newLine = newStart;
		for (const rawLine of bodyLines) {
			const prefix = parseLinePrefix(rawLine);
			if (prefix === undefined) continue; // malformed body line — skip defensively
			const text = rawLine.slice(1);
			if (prefix === "\\") {
				annotated.push({ prefix, text, headLine: null, oldLine, newLine });
			} else if (prefix === " ") {
				annotated.push({ prefix, text, headLine: newLine, oldLine, newLine });
				oldLine += 1;
				newLine += 1;
			} else if (prefix === "+") {
				annotated.push({ prefix, text, headLine: newLine, oldLine, newLine });
				newLine += 1;
			} else {
				annotated.push({ prefix, text, headLine: null, oldLine, newLine });
				oldLine += 1;
			}
		}
		return { oldStart, newStart, lines: annotated };
	});

	return { preamble, hunks };
}

function statusForHeadLine(
	headLine: number,
	ranges: readonly ReviewRange[],
): ReviewStatus {
	const range = ranges.find(
		(candidate) =>
			headLine >= candidate.startLine && headLine <= candidate.endLine,
	);
	return range?.status ?? "new";
}

/** Fills a line with no head number in from the nearest known status, forward first (deletions anchor to what comes right after them), then backward for a trailing run with nothing after. */
function resolveLineStatuses(
	hunkLines: readonly AnnotatedLine[],
	ranges: readonly ReviewRange[],
): readonly ReviewStatus[] {
	const direct = hunkLines.map((line) =>
		line.headLine === null
			? undefined
			: statusForHeadLine(line.headLine, ranges),
	);

	const forwardFilled = [...direct];
	for (let index = forwardFilled.length - 2; index >= 0; index -= 1) {
		if (forwardFilled[index] === undefined) {
			forwardFilled[index] = forwardFilled[index + 1];
		}
	}

	return forwardFilled.map((status, index) => {
		if (status !== undefined) return status;
		for (let back = index - 1; back >= 0; back -= 1) {
			const earlier = forwardFilled[back];
			if (earlier !== undefined) return earlier;
		}
		return "new"; // the whole hunk has no head line at all — never collapse it
	});
}

type RunSegment = {
	status: ReviewStatus;
	lines: AnnotatedLine[];
};

/** Groups one hunk's lines into consecutive same-status runs — never spanning across hunks, since two hunks' old/new counters aren't contiguous. */
function groupIntoRuns(
	hunkLines: readonly AnnotatedLine[],
	statuses: readonly ReviewStatus[],
): readonly RunSegment[] {
	const runs: RunSegment[] = [];
	hunkLines.forEach((line, index) => {
		const status = statuses[index] ?? "new";
		const currentRun = runs[runs.length - 1];
		if (currentRun?.status === status) {
			currentRun.lines.push(line);
			return;
		}
		runs.push({ status, lines: [line] });
	});
	return runs;
}

function serializeSubHunk(run: RunSegment): string {
	const first = run.lines[0];
	if (first === undefined) return "";
	const oldCount = run.lines.filter((line) => line.prefix !== "+").length;
	const newCount = run.lines.filter((line) => line.prefix !== "-").length;
	const header = `@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@`;
	const body = run.lines.map((line) => `${line.prefix}${line.text}`);
	return [header, ...body].join("\n");
}

function firstKeptHeadLine(
	segments: readonly RunSegment[],
	fromIndex: number,
): number | null {
	for (let index = fromIndex; index < segments.length; index += 1) {
		const segment = segments[index];
		if (segment === undefined || segment.status !== "new") continue;
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
		const statuses = resolveLineStatuses(hunk.lines, ranges);
		return groupIntoRuns(hunk.lines, statuses);
	});

	const keptSubHunks = segments
		.filter((segment) => segment.status === "new")
		.map(serializeSubHunk);

	if (keptSubHunks.length === 0) {
		const lineCount = ranges
			.filter((range) => range.status === "reviewed")
			.reduce((sum, range) => sum + (range.endLine - range.startLine + 1), 0);
		return { kind: "full", lineCount };
	}

	const gaps = segments.reduce<CollapsedGap[]>((acc, segment, index) => {
		if (segment.status !== "reviewed") return acc;
		const lineCount = segment.lines.filter(
			(line) => line.headLine !== null,
		).length;
		if (lineCount === 0) return acc;
		acc.push({ anchorLine: firstKeptHeadLine(segments, index + 1), lineCount });
		return acc;
	}, []);

	const keptSegmentsInOrder = segments.filter(
		(segment) => segment.status === "new",
	);
	const patchText = [
		preamble,
		...keptSegmentsInOrder.map(serializeSubHunk),
	].join("\n");

	return { kind: "partial", patch: patchText, gaps };
}
