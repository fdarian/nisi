import { type AnnotatedLine, parsePatchHunks } from "#/lib/diff-hunk-slicing";
import type { FileChange, FileContentsMap } from "#/lib/pr-data";

/**
 * One keyword-search hit, precise enough to drive both slicing
 * (`build-location-diff.ts`'s `LineRange`) and highlighting (Phase 3).
 * `offset`/`length` are character positions *within the stripped line
 * text* — the `+`/`-`/` ` prefix column is never part of a match, so a
 * query anchored at column 0 of a line's real content behaves.
 *
 * `headLine` follows `LineRange`'s 1-based head-file convention, for
 * `buildLocationFileDiff` — it is *not* necessarily where this match's text
 * actually renders. A match on a line with no head-side counterpart (a
 * removed `-` line) anchors `headLine` to the nearest line that has one —
 * forward first, then backward — mirroring `resolveLineDispositions`' own
 * "deletions anchor to what comes right after them" rule, so a `LineRange`
 * built around it already pulls the removed line in for free. The one case
 * this can't resolve is a hunk that touches no head line at all (every line
 * removed, no surviving context) — `buildLocationFileDiff` already refuses
 * to render such a hunk regardless of any range, so `findDiffMatches` drops
 * those matches rather than inventing a `headLine` with nothing behind it.
 *
 * `side`/`rowLine` locate the match's own rendered row instead, independent
 * of that anchoring — `@pierre/diffs` addresses a unified-view row by
 * `data-line`, and for a pure deletion row that's the *old*-file line number
 * (there is no new-file number to show), not `headLine`. For every other
 * line (context or added), the row's own number already equals `headLine`,
 * so `side` is `"additions"` and `rowLine === headLine`.
 */
export type DiffMatch = {
	path: string;
	headLine: number;
	offset: number;
	length: number;
	side: "additions" | "deletions";
	rowLine: number;
};

type LineMatch = { offset: number; length: number };

/** Every occurrence of `query` in `text`, non-overlapping, in ascending offset order. `query` must already be lowercased by the caller. */
function findLineMatches(text: string, query: string): LineMatch[] {
	const lowerText = text.toLowerCase();
	const matches: LineMatch[] = [];
	let searchFrom = 0;
	while (searchFrom <= lowerText.length) {
		const index = lowerText.indexOf(query, searchFrom);
		if (index === -1) break;
		matches.push({ offset: index, length: query.length });
		searchFrom = index + query.length;
	}
	return matches;
}

/** The nearest head line for `lines[index]` when that line itself has none — forward first, then backward. `undefined` when no line in the hunk has a head line at all. */
function nearestHeadLine(
	lines: readonly AnnotatedLine[],
	index: number,
): number | undefined {
	for (let forward = index; forward < lines.length; forward += 1) {
		const headLine = lines[forward]?.headLine;
		if (headLine != null) return headLine;
	}
	for (let backward = index - 1; backward >= 0; backward -= 1) {
		const headLine = lines[backward]?.headLine;
		if (headLine != null) return headLine;
	}
	return undefined;
}

/** One file's matches, path-less — `findDiffMatches` attaches `path` once it fans this out across files. */
function findPatchMatches(
	patch: string,
	query: string,
): Array<Omit<DiffMatch, "path">> {
	const { hunks } = parsePatchHunks(patch);
	const matches: Array<Omit<DiffMatch, "path">> = [];
	for (const hunk of hunks) {
		hunk.lines.forEach((line, index) => {
			if (line.prefix === "\\") return; // "\ No newline at end of file" — never content
			const lineMatches = findLineMatches(line.text, query);
			if (lineMatches.length === 0) return;
			const headLine = line.headLine ?? nearestHeadLine(hunk.lines, index);
			if (headLine == null) return; // hunk touches no head line at all — see DiffMatch's doc comment
			const side: DiffMatch["side"] =
				line.prefix === "-" ? "deletions" : "additions";
			const rowLine = line.prefix === "-" ? line.oldLine : line.newLine;
			for (const match of lineMatches) {
				matches.push({ headLine, side, rowLine, ...match });
			}
		});
	}
	return matches;
}

/**
 * Every match of `query` across `files`, in stable document order — file
 * order exactly as `files` is given (callers pass the rendered order), then
 * line, then offset — since the "x of y" counter and `n`/`N` navigation
 * index straight into this list. Skips the `---`/`+++` preamble and every
 * `@@` hunk header (`parsePatchHunks` already separates those out), and a
 * file whose content hasn't loaded (or errored) simply contributes no
 * matches, same as `diffContentMatchesQuery` used to. `query` must already
 * be lowercased by the caller. An empty query matches nothing.
 */
export function findDiffMatches(
	files: readonly Pick<FileChange, "path">[],
	fileContents: FileContentsMap,
	query: string,
): DiffMatch[] {
	if (query === "") return [];
	const matches: DiffMatch[] = [];
	for (const file of files) {
		const content = fileContents.get(file.path)?.content;
		if (content === undefined) continue;
		for (const match of findPatchMatches(content.patch, query)) {
			matches.push({ path: file.path, ...match });
		}
	}
	return matches;
}

/**
 * Keyword-search mode's file-filter predicate — a file matches once it has
 * at least one hit, computed by the same `findPatchMatches` the match model
 * itself uses, so the sidebar's filter and the diff pane's narrowing can
 * never drift into two different notions of "this file matches". `query`
 * must already be lowercased by the caller, same convention the path filter
 * uses.
 */
export function diffContentMatchesQuery(
	content: { patch: string } | undefined,
	query: string,
): boolean {
	if (content === undefined || query === "") return false;
	return findPatchMatches(content.patch, query).length > 0;
}
