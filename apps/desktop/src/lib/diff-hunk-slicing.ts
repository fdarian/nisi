/**
 * Shared pure primitives behind PLAN.md's "synthesize a unified diff
 * containing only the hunks overlapping the target range, with correct `@@`
 * offsets" mechanism. Both Phase 2's collapsed-reviewed-region rendering
 * (`build-collapsed-diff.ts`) and Phase 3's reference-block rendering
 * (`build-location-diff.ts`) need to keep some head-file lines of a patch and
 * drop others while preserving each surviving run's real `@@` position — this
 * is the one place that parses a patch into per-line old/new positions and
 * re-serializes a subset of them as valid sub-hunks. A kept run's first
 * line's old/new position already encodes the correct `@@` offset, so
 * omitting hunks (or slices of one) around it needs no offset recalculation.
 */
import { HUNK_HEADER } from "@pierre/diffs";

export type LinePrefix = " " | "+" | "-" | "\\";

export type AnnotatedLine = {
	prefix: LinePrefix;
	text: string;
	/** 1-based head (new-file) line number; `null` for lines with no head-side counterpart. */
	headLine: number | null;
	oldLine: number;
	newLine: number;
};

export type ParsedHunk = {
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
export function parsePatchHunks(patch: string): {
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

export type LineDisposition = "keep" | "drop";

/**
 * Resolves each line's disposition via `classify` (only lines with a head
 * line number can be classified directly), then fills every line with no
 * head number in from the nearest known disposition — forward first
 * (deletions anchor to what comes right after them), then backward for a
 * trailing run with nothing after. `fallbackWhenNoHeadLineAnywhere` covers
 * the rare hunk with no head-side line at all — callers pick its direction
 * (Phase 2 never collapses such a hunk; Phase 3 never keeps one, since it
 * can't belong to any head-line range).
 *
 * `D` is generic, not just `LineDisposition` — Phase 3's collapsed-region
 * grouping (`build-collapsed-diff.ts`) needs more than two dispositions (one
 * "drop" variant per claim, so adjacent reviewed runs from different claims
 * don't merge into one collapsed marker), and this primitive doesn't care
 * about the disposition alphabet's shape, only that it's comparable by `===`.
 */
export function resolveLineDispositions<D extends string>(
	hunkLines: readonly AnnotatedLine[],
	classify: (headLine: number) => D,
	fallbackWhenNoHeadLineAnywhere: D,
): readonly D[] {
	const direct = hunkLines.map((line) =>
		line.headLine === null ? undefined : classify(line.headLine),
	);

	const forwardFilled = [...direct];
	for (let index = forwardFilled.length - 2; index >= 0; index -= 1) {
		if (forwardFilled[index] === undefined) {
			forwardFilled[index] = forwardFilled[index + 1];
		}
	}

	return forwardFilled.map((disposition, index) => {
		if (disposition !== undefined) return disposition;
		for (let back = index - 1; back >= 0; back -= 1) {
			const earlier = forwardFilled[back];
			if (earlier !== undefined) return earlier;
		}
		return fallbackWhenNoHeadLineAnywhere;
	});
}

export type RunSegment<D extends string = LineDisposition> = {
	disposition: D;
	lines: AnnotatedLine[];
};

/**
 * Groups one hunk's lines into consecutive same-disposition runs — never
 * spanning across hunks, since two hunks' old/new counters aren't
 * contiguous. `dispositions` always has exactly one entry per line of
 * `hunkLines` (it's `resolveLineDispositions`' output, computed from the same
 * `hunkLines`) — an index miss would mean that invariant broke, so this
 * throws rather than papering over it with a fabricated disposition.
 */
export function groupIntoRuns<D extends string>(
	hunkLines: readonly AnnotatedLine[],
	dispositions: readonly D[],
): readonly RunSegment<D>[] {
	const runs: RunSegment<D>[] = [];
	hunkLines.forEach((line, index) => {
		const disposition = dispositions[index];
		if (disposition === undefined) {
			throw new Error(
				"groupIntoRuns: dispositions must have exactly one entry per hunk line",
			);
		}
		const currentRun = runs[runs.length - 1];
		if (currentRun?.disposition === disposition) {
			currentRun.lines.push(line);
			return;
		}
		runs.push({ disposition, lines: [line] });
	});
	return runs;
}

/** Re-serializes one run as a standalone sub-hunk — its first line's old/new position already encodes the correct `@@` offset, so no recalculation is needed. */
export function serializeSubHunk(run: RunSegment<string>): string {
	const first = run.lines[0];
	if (first === undefined) return "";
	const oldCount = run.lines.filter((line) => line.prefix !== "+").length;
	const newCount = run.lines.filter((line) => line.prefix !== "-").length;
	const header = `@@ -${first.oldLine},${oldCount} +${first.newLine},${newCount} @@`;
	const body = run.lines.map((line) => `${line.prefix}${line.text}`);
	return [header, ...body].join("\n");
}
