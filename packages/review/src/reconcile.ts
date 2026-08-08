import type { GitCommandError, Hunk } from "@repo/git";
import { diffContents } from "@repo/git";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

/**
 * What currently vouches for a reviewed range: the whole-file Reviewed
 * checkbox, or one walkthrough reference block's claim on a specific
 * location. Files Changed renders the latter as a "reviewed in
 * `<blockLabel>`" marker linking back to the block — `"reviewed"` alone
 * isn't enough to do that, so every surviving range carries this instead of
 * a bare status.
 */
export type ReviewSource =
	| { readonly kind: "file" }
	| {
			readonly kind: "range";
			readonly blockId: string;
			readonly blockLabel: string;
	  };

/**
 * One tick of Reviewed — either the whole-file checkbox (`ranges: null`) or
 * a walkthrough reference block's claim on a set of line ranges within one
 * file (`ranges`, non-empty, in `snapshotContent`'s own coordinates — which
 * is head-at-tick-time, since a claim always snapshots the file it's
 * ticked against). Whole-file review is exactly the degenerate case of a
 * claim ranging over the entire file; `reconcile` treats both identically
 * once `ranges` is normalized.
 */
export type ReviewClaim = {
	readonly source: ReviewSource;
	readonly snapshotContent: string;
	readonly ranges: ReadonlyArray<{
		readonly startLine: number;
		readonly endLine: number;
	}> | null;
	/**
	 * Epoch ms this claim was last (re-)ticked. Multiple claims — a whole-file
	 * review and one or more block-scoped ranges, ticked at different times
	 * with different snapshots — can all still cover the same head line once
	 * `diff(snapshot, head)` comes back empty for each; the most recently
	 * ticked one wins the attribution on that line.
	 */
	readonly viewedAt: number;
};

/**
 * One contiguous run of a file's `base → head` diff, tagged by whether it's
 * still exactly what some claim reviewed (`reviewed`, collapsible behind a
 * marker — see `reviewedVia` for which claim) or has moved since (`new`,
 * surfaced). Line numbers are 1-based inclusive, in **head** (current
 * worktree) coordinates — the same numbering the `base → head` diff itself
 * renders lines under, since head is literally the file on screen.
 */
export type ReviewRange = {
	readonly startLine: number;
	readonly endLine: number;
	readonly status: "reviewed" | "new";
	/** Which claim currently vouches for this range. `null` iff `status` is `"new"`. */
	readonly reviewedVia: ReviewSource | null;
};

export type Reconciliation = {
	/** `true` iff at least one range came back `"new"` — the file has content no surviving claim covers. */
	readonly changedSinceReview: boolean;
	readonly ranges: ReadonlyArray<ReviewRange>;
	/**
	 * The synthetic "before" file a genuine `reviewedBaseline → head` diff can
	 * be computed against — `null` when the file has no active claim at all
	 * (`claims` was empty). See `synthesizeReviewedBaseline`'s doc comment for
	 * how it's built; the short version is it's the `base → head` alignment
	 * with every still-`"reviewed"` span pulled back to head's text (so it
	 * reads as unchanged) and every deletion the user has plausibly already
	 * seen omitted.
	 */
	readonly reviewedBaseline: string | null;
};

/**
 * Whether any range of a reconciliation is still `"new"` — the file has a
 * changed line no surviving claim (whole-file or block-scoped) covers.
 * Deliberately narrower than `changedSinceReview`, which also flags a
 * whole-file claim whose snapshot no longer matches head even when that
 * leaves zero visible ranges (e.g. the file was deleted since review) — a
 * caller deciding whether every changed line is *covered* only cares about
 * `ranges`, not that unrelated divergence signal.
 */
export const hasUnreviewedRanges = (reconciliation: Reconciliation): boolean =>
	reconciliation.ranges.some((range) => range.status === "new");

type Interval = { readonly start: number; readonly end: number };

/** A line number past any real file's length — the open end of a claim's whole-file range, or of the last unchanged run in a diff. Never rendered; every consumer clips it against a real bound (a base-hunk's head interval) before it reaches the wire. */
const MAX_LINE = Number.MAX_SAFE_INTEGER;

type Segment = {
	readonly oldStart: number;
	readonly oldEnd: number;
	readonly headStart: number;
	readonly headEnd: number;
};

/**
 * Splits a `diff(oldContent, newContent)` into the unchanged runs between
 * its hunks, in both coordinate spaces at once — the mechanism that lets a
 * claim's originally-claimed range (fixed in *old*, i.e. snapshot,
 * coordinates) be projected onto *current* head coordinates even when
 * unrelated edits elsewhere shifted every line number in between. A pure
 * insertion (`oldLines === 0`) consumes no old lines — it only shifts what
 * comes after; a pure deletion (`newLines === 0`) is the mirror. Both
 * anchor at the surviving line immediately adjacent, matching how
 * `Hunk.oldStart`/`newStart` are already defined for a zero-length side.
 */
const unchangedSegments = (
	hunks: ReadonlyArray<Hunk>,
): ReadonlyArray<Segment> => {
	const sorted = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
	const segments: Array<Segment> = [];
	let oldCursor = 1;
	let headCursor = 1;

	for (const hunk of sorted) {
		const oldTouchedStart =
			hunk.oldLines > 0 ? hunk.oldStart : hunk.oldStart + 1;
		const oldTouchedEnd =
			hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines - 1 : hunk.oldStart;
		const headTouchedEnd =
			hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;

		if (oldTouchedStart > oldCursor) {
			const gapLength = oldTouchedStart - 1 - oldCursor;
			segments.push({
				oldStart: oldCursor,
				oldEnd: oldTouchedStart - 1,
				headStart: headCursor,
				headEnd: headCursor + gapLength,
			});
		}
		oldCursor = oldTouchedEnd + 1;
		headCursor = headTouchedEnd + 1;
	}

	segments.push({
		oldStart: oldCursor,
		oldEnd: MAX_LINE,
		headStart: headCursor,
		headEnd: MAX_LINE,
	});
	return segments;
};

/** Projects old-coordinate ranges through `unchangedSegments`' mapping onto head coordinates — the portions that fall inside a touched hunk simply drop out, since that original content no longer survives unchanged. */
const projectRanges = (
	ranges: ReadonlyArray<{
		readonly startLine: number;
		readonly endLine: number;
	}>,
	segments: ReadonlyArray<Segment>,
): ReadonlyArray<Interval> => {
	const result: Array<Interval> = [];
	for (const range of ranges) {
		for (const segment of segments) {
			const start = Math.max(range.startLine, segment.oldStart);
			const end = Math.min(range.endLine, segment.oldEnd);
			if (start > end) continue;
			const shift = segment.headStart - segment.oldStart;
			result.push({ start: start + shift, end: end + shift });
		}
	}
	return result;
};

type AttributedInterval = Interval & {
	readonly source: ReviewSource;
	readonly viewedAt: number;
};

const wholeFileRange = [{ startLine: 1, endLine: MAX_LINE }];

/**
 * The head-coordinate intervals one claim currently still covers. Skips the
 * `diff(snapshot, head)` call entirely when the snapshot is byte-identical
 * to head — the common case (nothing edited since this claim was ticked) —
 * same optimization Phase 2's single-claim `reconcile` had.
 */
const projectClaimCoverage = (
	repoRoot: string,
	claim: ReviewClaim,
	headContent: string,
): Effect.Effect<
	ReadonlyArray<AttributedInterval>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const ranges = claim.ranges ?? wholeFileRange;
		const attribute = (interval: Interval): AttributedInterval => ({
			...interval,
			source: claim.source,
			viewedAt: claim.viewedAt,
		});

		if (claim.snapshotContent === headContent) {
			return ranges.map((r) =>
				attribute({ start: r.startLine, end: r.endLine }),
			);
		}

		const hunks = yield* diffContents(
			repoRoot,
			claim.snapshotContent,
			headContent,
		);
		const segments = unchangedSegments(hunks);
		return projectRanges(ranges, segments).map(attribute);
	});

const sameSource = (a: ReviewSource, b: ReviewSource): boolean =>
	a.kind === "file" && b.kind === "file"
		? true
		: a.kind === "range" && b.kind === "range" && a.blockId === b.blockId;

/**
 * Splits one `base → head` hunk's head-line range against every claim's
 * (already head-projected) coverage, alternating `reviewed`/`new`
 * sub-ranges that together cover the whole input range exactly once. Where
 * multiple claims cover the same point — a whole-file review and a
 * block-scoped range both still surviving, say — the most recently ticked
 * one (`viewedAt`) wins the attribution.
 */
const splitRangeByClaims = (
	range: Interval,
	coverage: ReadonlyArray<AttributedInterval>,
): ReadonlyArray<ReviewRange> => {
	const clipped = coverage
		.map((c) => ({
			start: Math.max(c.start, range.start),
			end: Math.min(c.end, range.end),
			source: c.source,
			viewedAt: c.viewedAt,
		}))
		.filter((c) => c.start <= c.end);

	const breakpoints = new Set<number>([range.start, range.end + 1]);
	for (const c of clipped) {
		breakpoints.add(c.start);
		breakpoints.add(c.end + 1);
	}
	const sorted = [...breakpoints].sort((a, b) => a - b);

	const result: Array<ReviewRange> = [];
	for (let i = 0; i < sorted.length - 1; i++) {
		const segStart = sorted[i] as number;
		const segEnd = (sorted[i + 1] as number) - 1;
		if (segStart > segEnd) continue;

		const covering = clipped.filter(
			(c) => c.start <= segStart && c.end >= segEnd,
		);
		const winner = covering.reduce<AttributedInterval | null>(
			(best, c) => (best === null || c.viewedAt > best.viewedAt ? c : best),
			null,
		);
		const status = winner === null ? "new" : "reviewed";
		const reviewedVia = winner === null ? null : winner.source;

		const prev = result.at(-1);
		if (
			prev !== undefined &&
			prev.status === status &&
			prev.endLine === segStart - 1 &&
			(reviewedVia === null || prev.reviewedVia === null
				? reviewedVia === prev.reviewedVia
				: sameSource(prev.reviewedVia, reviewedVia))
		) {
			result[result.length - 1] = { ...prev, endLine: segEnd };
		} else {
			result.push({
				startLine: segStart,
				endLine: segEnd,
				status,
				reviewedVia,
			});
		}
	}
	return result;
};

/** Splits `content` into its lines, dropping the one artifact trailing `"\n"` produces — the same line numbering `Hunk.oldStart`/`newStart` already assume. */
const splitLines = (content: string): ReadonlyArray<string> => {
	if (content === "") return [];
	return content.endsWith("\n")
		? content.slice(0, -1).split("\n")
		: content.split("\n");
};

/**
 * Synthesizes the "before" side of a `reviewedBaseline → head` diff by
 * walking the `base → head` alignment (`hunks`, already computed by
 * `reconcile` for `ranges`) and, at every point the alignment moves off
 * "unchanged", asking `coverage` (via `splitRangeByClaims`, the same
 * attribution `ranges` itself is built from — no second pass) whether head's
 * side of that point is still exactly what some claim vouches for:
 *
 * - Context (untouched by any hunk): head's text carries over as-is — it's
 *   identical to base's, so no claim needs to vouch for it.
 * - An added head line: carried over only if `"reviewed"` — it's new
 *   otherwise, and the whole point of the baseline is to not pretend the
 *   user already saw it.
 * - A hunk's deleted base lines: restored — unless *both* the head line
 *   immediately before the hunk and the first head line the hunk resumes at
 *   (its `added` lines when there are any, otherwise the next context line)
 *   are `"reviewed"`, in which case the deletion sits entirely inside
 *   content the user has already looked at since and can stay omitted. Any
 *   ambiguity (start/end of file, no coverage on one side) resolves to
 *   restoring the deletion — showing it again is recoverable, hiding a real
 *   deletion is not.
 *
 * `coverage`'s own attribution is re-run once over the *entire* head file
 * (`{ start: 1, end: MAX_LINE }`, not just the hunks' domain `ranges` uses)
 * so a query at any head line — including the context lines flanking a pure
 * deletion, which never appear in `ranges` at all — has an answer. Every
 * query this function makes lands at a strictly increasing head line, so
 * that full-file partition only ever needs one forward-moving cursor, not a
 * lookup per query.
 */
const synthesizeReviewedBaseline = (
	hunks: ReadonlyArray<Hunk>,
	headContent: string,
	coverage: ReadonlyArray<AttributedInterval>,
): string => {
	const headLines = splitLines(headContent);
	const fullDomainRuns = splitRangeByClaims(
		{ start: 1, end: MAX_LINE },
		coverage,
	);

	let runCursor = 0;
	const isReviewedAt = (line: number): boolean => {
		if (line < 1 || line > headLines.length) return false; // doesn't exist — ambiguous, not reviewed
		while (
			runCursor < fullDomainRuns.length - 1 &&
			(fullDomainRuns[runCursor] as ReviewRange).endLine < line
		) {
			runCursor += 1;
		}
		const run = fullDomainRuns[runCursor];
		return run !== undefined && run.status === "reviewed";
	};

	const sortedHunks = [...hunks].sort((a, b) => a.oldStart - b.oldStart);
	const output: Array<string> = [];
	let headCursor = 1;

	for (const hunk of sortedHunks) {
		const headTouchedStart =
			hunk.newLines > 0 ? hunk.newStart : hunk.newStart + 1;
		const headTouchedEnd =
			hunk.newLines > 0 ? hunk.newStart + hunk.newLines - 1 : hunk.newStart;

		for (let line = headCursor; line < headTouchedStart; line++) {
			const text = headLines[line - 1];
			if (text !== undefined) output.push(text);
		}

		// Unified-diff hunks always list every removed line before every added
		// one, regardless of how git's own algorithm interleaved them internally.
		const removed = hunk.lines
			.filter((line) => line.startsWith("-"))
			.map((line) => line.slice(1));
		const added = hunk.lines
			.filter((line) => line.startsWith("+"))
			.map((line) => line.slice(1));

		if (removed.length > 0) {
			const bothReviewed =
				isReviewedAt(headTouchedStart - 1) && isReviewedAt(headTouchedStart);
			if (!bothReviewed) output.push(...removed);
		}

		for (let index = 0; index < added.length; index++) {
			if (isReviewedAt(headTouchedStart + index)) {
				output.push(added[index] as string);
			}
		}

		headCursor = headTouchedEnd + 1;
	}

	for (let line = headCursor; line <= headLines.length; line++) {
		const text = headLines[line - 1];
		if (text !== undefined) output.push(text);
	}

	if (output.length === 0) return "";
	const body = output.join("\n");
	return headContent.endsWith("\n") ? `${body}\n` : body;
};

/**
 * Reconciliation over `base` (merge-base content), every currently-active
 * review claim on the file (whole-file and/or block-scoped ranges), and
 * `head` (current worktree content). Missing content (a file that doesn't
 * exist at that state — e.g. `base` for an added file, or `head` for one
 * since deleted) is `""`, matching how `@repo/git` and `ReviewStore` already
 * treat a missing file as an empty diff side.
 *
 * `ranges` only ever covers the `base → head` diff's added lines — claims
 * are projected onto head coordinates independently of it, so nothing here
 * is computed relative to a stale line number; everything is re-derived
 * from current content on every call. Pass `claims: []` when the file has
 * never been reviewed at all — the caller should skip calling this
 * entirely in that case (see `ReviewStore`'s callers), since the result is
 * simply every hunk reported `"new"`.
 */
export const reconcile = (
	repoRoot: string,
	input: {
		readonly baseContent: string;
		readonly headContent: string;
		readonly claims: ReadonlyArray<ReviewClaim>;
	},
): Effect.Effect<
	Reconciliation,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const baseHeadHunks = yield* diffContents(
			repoRoot,
			input.baseContent,
			input.headContent,
		);

		const perClaimCoverage = yield* Effect.forEach(
			input.claims,
			(claim) => projectClaimCoverage(repoRoot, claim, input.headContent),
			{ concurrency: "unbounded" },
		);
		const coverage = perClaimCoverage.flat();

		const ranges = baseHeadHunks
			.filter((hunk) => hunk.newLines > 0)
			.flatMap((hunk) =>
				splitRangeByClaims(
					{ start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 },
					coverage,
				),
			);

		// A whole-file claim whose snapshot no longer matches head is "changed"
		// even when that leaves zero visible ranges — e.g. the file was deleted
		// since review, so there's nothing left to render but the divergence is
		// still real. Range claims don't get this extra check: their own
		// claimed lines already surface via `ranges` wherever they still fall
		// inside the base→head diff's domain.
		const fileClaimChanged = input.claims.some(
			(claim) =>
				claim.ranges === null && claim.snapshotContent !== input.headContent,
		);

		const reviewedBaseline =
			input.claims.length === 0
				? null
				: synthesizeReviewedBaseline(
						baseHeadHunks,
						input.headContent,
						coverage,
					);

		return {
			changedSinceReview:
				fileClaimChanged || ranges.some((r) => r.status === "new"),
			ranges,
			reviewedBaseline,
		};
	});
