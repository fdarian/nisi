import type { GitCommandError, Hunk } from "@repo/git";
import { diffContents } from "@repo/git";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";

/**
 * One contiguous run of a file's `base → head` diff, tagged by whether it's
 * still exactly what was reviewed (`reviewed`, collapsible behind a marker)
 * or has moved since (`new`, surfaced). Line numbers are 1-based inclusive,
 * in **head** (current worktree) coordinates — the same numbering the
 * `base → head` diff itself renders lines under, since head is literally
 * the file on screen. The frontend can feed these straight to the diff
 * renderer's per-line annotation hook without re-deriving anything.
 */
export type ReviewRange = {
	readonly startLine: number;
	readonly endLine: number;
	readonly status: "reviewed" | "new";
};

export type Reconciliation = {
	/** `reviewed content !== head content` — cheap boolean the caller can also get without diffing (see `changedSinceReview` on `FileChange.review`). */
	readonly changedSinceReview: boolean;
	readonly ranges: ReadonlyArray<ReviewRange>;
};

type HeadInterval = { readonly start: number; readonly end: number };

/**
 * Projects a `diff(reviewed, head)` hunk onto a head-line interval. A hunk
 * with `newLines > 0` covers exactly those head lines. A pure-deletion hunk
 * (`newLines === 0` — content present in `reviewed` is simply gone from
 * `head`) has no head lines of its own; it's anchored to the single head
 * line the deletion sits against, so a base-hunk range straddling that
 * point still gets split instead of silently staying "reviewed" — a
 * deletion since review is still something new to surface.
 */
const toHeadInterval = (hunk: Hunk): HeadInterval =>
	hunk.newLines > 0
		? { start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 }
		: { start: Math.max(1, hunk.newStart), end: Math.max(1, hunk.newStart) };

const mergeIntervals = (
	intervals: ReadonlyArray<HeadInterval>,
): ReadonlyArray<HeadInterval> => {
	const sorted = [...intervals].sort((a, b) => a.start - b.start);
	const merged: Array<{ start: number; end: number }> = [];
	for (const interval of sorted) {
		const last = merged.at(-1);
		if (last !== undefined && interval.start <= last.end + 1) {
			last.end = Math.max(last.end, interval.end);
		} else {
			merged.push({ start: interval.start, end: interval.end });
		}
	}
	return merged;
};

/**
 * Splits one `base → head` hunk's head-line range against the
 * (already-merged) intervals `diff(reviewed, head)` touched, alternating
 * `reviewed`/`new` sub-ranges that together cover the whole input range
 * exactly once. This is what makes "reviewed hunk, edited again in the
 * middle of it" collapse only the parts that are still untouched instead of
 * the whole hunk either way.
 */
const splitRange = (
	range: HeadInterval,
	touched: ReadonlyArray<HeadInterval>,
): ReadonlyArray<ReviewRange> => {
	const overlapping = touched.filter(
		(interval) => interval.end >= range.start && interval.start <= range.end,
	);

	const result: Array<ReviewRange> = [];
	let cursor = range.start;
	for (const interval of overlapping) {
		const start = Math.max(interval.start, range.start);
		const end = Math.min(interval.end, range.end);
		if (start > cursor) {
			result.push({
				startLine: cursor,
				endLine: start - 1,
				status: "reviewed",
			});
		}
		result.push({ startLine: start, endLine: end, status: "new" });
		cursor = end + 1;
	}
	if (cursor <= range.end) {
		result.push({ startLine: cursor, endLine: range.end, status: "reviewed" });
	}
	return result;
};

/**
 * Three-way reconciliation: `base` (merge-base content), `reviewed` (the
 * snapshot taken when Reviewed was last ticked), `head` (current worktree
 * content). Missing content (a file that doesn't exist at that state — e.g.
 * `base` for an added file, or `head` for one since deleted) is `""`,
 * matching how `@repo/git` and `ReviewStore.markFileViewed` already treat a
 * missing file as an empty diff side.
 *
 * Both `base → head` and `reviewed → head` are diffed against the *same*
 * `head` content, so their new-side line numbers share one coordinate space
 * with no translation needed between them — the mechanism that keeps ranges
 * correct even when an edit shifts every line number above it: nothing is
 * ever computed relative to a stale line number, everything is re-derived
 * from current content on every call.
 */
export const reconcile = (
	repoRoot: string,
	input: {
		readonly baseContent: string;
		readonly reviewedContent: string;
		readonly headContent: string;
	},
): Effect.Effect<
	Reconciliation,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const changedSinceReview = input.reviewedContent !== input.headContent;
		const baseHeadHunks = yield* diffContents(
			repoRoot,
			input.baseContent,
			input.headContent,
		);

		if (!changedSinceReview) {
			const ranges = baseHeadHunks
				.filter((hunk) => hunk.newLines > 0)
				.map(
					(hunk): ReviewRange => ({
						startLine: hunk.newStart,
						endLine: hunk.newStart + hunk.newLines - 1,
						status: "reviewed",
					}),
				);
			return { changedSinceReview: false, ranges };
		}

		const reviewedHeadHunks = yield* diffContents(
			repoRoot,
			input.reviewedContent,
			input.headContent,
		);
		const touched = mergeIntervals(reviewedHeadHunks.map(toHeadInterval));

		const ranges = baseHeadHunks
			.filter((hunk) => hunk.newLines > 0)
			.flatMap((hunk) =>
				splitRange(
					{ start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 },
					touched,
				),
			);

		return { changedSinceReview: true, ranges };
	});
