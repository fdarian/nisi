import type { FileReviewState } from "./store.ts";

/**
 * Looks up a file's review state by its current path, falling back to its
 * pre-rename path when nothing's recorded under the new one. A rename
 * doesn't carry its `reviewed_files` row forward on its own — that row is
 * keyed by path, and a rename changes the path — but the review snapshot it
 * captured is still the right thing to reconcile the renamed file's
 * *content* against, so the fallback keeps tracked-changes working across a
 * rename instead of silently losing the review.
 */
export const resolveReviewState = (
	states: ReadonlyMap<string, FileReviewState>,
	path: string,
	oldPath: string | undefined,
): FileReviewState | null =>
	states.get(path) ??
	(oldPath === undefined ? undefined : states.get(oldPath)) ??
	null;
