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

/** `#L131-133`, or `#L131` for a single-line reference — the line-range suffix shared by both formatters below. */
function formatLineRangeSuffix(reference: DiffSelectionReference): string {
	return reference.startLine === reference.endLine
		? `#L${reference.startLine}`
		: `#L${reference.startLine}-${reference.endLine}`;
}

/**
 * `relative/path.ts#L131-133` — repo-relative path plus a 1-based, inclusive
 * line range. A single-line reference drops the range: `path.ts#L131`. The
 * clipboard and the outgoing chat message both need this full form, not
 * `formatSelectionReferenceShort` below — the repo-relative path is what
 * makes the reference unambiguous outside the chip UI that already has
 * other context (which PR, which thread) narrowing it down.
 */
export function formatSelectionReference(
	reference: DiffSelectionReference,
): string {
	return `${reference.path}${formatLineRangeSuffix(reference)}`;
}

/**
 * `diff-selection-popover.tsx#L131-133` — basename only (no directories)
 * plus the same line range. Display-only, for the composer's reference
 * chips (`chat-composer.tsx`'s `ReferenceChip`): a chip has too little
 * width for a full repo-relative path, and unlike the line range, truncating
 * the path's *tail* would cut the part that actually identifies the
 * selection. Pair this with `formatSelectionReference` in a `title` so
 * hovering still reveals the full path when two files share a basename.
 */
export function formatSelectionReferenceShort(
	reference: DiffSelectionReference,
): string {
	const basename = reference.path.split("/").pop() ?? reference.path;
	return `${basename}${formatLineRangeSuffix(reference)}`;
}
