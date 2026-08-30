"use client";

/**
 * One resolved diff selection's *identity* — the file it's in and its
 * head-relative line range (see `use-diff-selection.ts`'s `resolveHeadRange`
 * doc comment for what "head-relative" means when the selection touches
 * removed lines). Deliberately carries no rect: unlike the selection itself,
 * the anchor position needs to keep changing as the pane scrolls, and
 * folding a live-updating field into this object would make every scroll
 * tick look like a brand-new selection to anything comparing `reference` by
 * identity (`DiffSelectionPopover`'s mount-animation guard, the "did the
 * selection change" copied-state reset).
 *
 * Lives here, not in `use-diff-selection.ts`, because both the diff pane and
 * the chat dock need it — a chat-dock module reaching into a diff-pane
 * hook for a type would be the wrong dependency direction.
 */
export type DiffSelectionReference = {
	path: string;
	startLine: number;
	endLine: number;
};

/** `relative/path.ts#L131-133` — repo-relative path plus a 1-based, inclusive line range. A single-line reference drops the range: `path.ts#L131`. */
export function formatSelectionReference(
	reference: DiffSelectionReference,
): string {
	return reference.startLine === reference.endLine
		? `${reference.path}#L${reference.startLine}`
		: `${reference.path}#L${reference.startLine}-${reference.endLine}`;
}
