import type { FileReviewState } from "./store.ts";

/**
 * Looks up a value keyed by a file's current path, falling back to its
 * pre-rename path when nothing's recorded under the new one. A rename
 * doesn't carry a path-keyed row forward on its own — the row's key is the
 * path, and a rename changes the path — but the review state it holds is
 * still the right thing to reconcile the renamed file's *content* against,
 * so the fallback keeps tracked-changes working across a rename instead of
 * silently losing it. Shared by whole-file review state and range claims —
 * both are keyed by path the same way, for the same reason.
 */
export const resolveByPath = <T>(
	states: ReadonlyMap<string, T>,
	path: string,
	oldPath: string | undefined,
): T | undefined =>
	states.get(path) ?? (oldPath === undefined ? undefined : states.get(oldPath));

export const resolveReviewState = (
	states: ReadonlyMap<string, FileReviewState>,
	path: string,
	oldPath: string | undefined,
): FileReviewState | null => resolveByPath(states, path, oldPath) ?? null;
