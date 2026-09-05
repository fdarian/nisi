"use client";

/**
 * Owns both ways a user can select a range in the diff pane — dragging (or
 * clicking) the line-number gutter, which `@pierre/diffs` itself tracks via
 * `enableLineSelection`/`selectedLines`, and a plain click-drag over the code
 * text, which is native browser selection `@pierre/diffs` never sees — and
 * normalizes whichever is active to one shape: the file path and a
 * head-relative line range (`reference`), plus a client rect to anchor a
 * floating action against (`anchorRect`, kept separate — see its own doc
 * comment below). The pane and the floating "Copy reference" button both
 * consume that shape; neither needs to know two selection mechanisms exist.
 *
 * Only one selection is ever "active": starting a gutter drag clears any
 * live text selection and vice versa, so the pane never has to reconcile two
 * simultaneous highlights or show two floating buttons.
 */
import type { CodeViewLineSelection, SelectionSide } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isEventOriginOnGutter, pollUntilReady } from "#/lib/diff-match-dom";
import type { DiffSelectionReference } from "#/lib/diff-reference";

type UseDiffSelectionOptions<Metadata> = {
	/** The same `CodeViewHandle` ref passed to `<DiffCodeView ref>` — used to reach a selected item's rendered shadow root (for the gutter path's anchor rect) and to resolve which item id a native text selection landed in. */
	codeViewRef: React.RefObject<CodeViewHandle<Metadata, undefined> | null>;
	/** `CodeViewItem.id -> repo-relative path`. `DiffPane` happens to use the path as the id directly, but this hook doesn't assume that — `undefined` means "don't resolve a reference for this item" (e.g. an id this pane doesn't recognize). */
	resolveItemPath: (itemId: string) => string | undefined;
};

type UseDiffSelectionResult = {
	/** Feed straight to `<DiffCodeView selectedLines>`. */
	selectedLines: CodeViewLineSelection | null;
	/** Feed straight to `<DiffCodeView onSelectedLinesChange>`. */
	onSelectedLinesChange: (selection: CodeViewLineSelection | null) => void;
	/** The floating button's target, or `null` when nothing resolves to one — no selection, a collapsed caret, or a text drag that crossed into a second file (see `resolveActiveTextSelection`'s doc comment). */
	reference: DiffSelectionReference | null;
	/**
	 * Where to anchor the floating button right now, or `null` when the
	 * selected rows aren't currently resolvable — scrolled out of
	 * `@pierre/diffs`' virtualized render window, or (for a text selection)
	 * the underlying `Range` collapsed. `null` here means "hide the button,
	 * but keep `reference`/the underlying selection intact" — the button
	 * reappears at the right spot once `refreshAnchorRect` finds the rows
	 * again, rather than the whole selection being dropped and re-made.
	 */
	anchorRect: DOMRect | null;
	/**
	 * Re-measures `anchorRect` straight from the DOM. Call on every
	 * `CodeView` scroll tick (`DiffPane`'s `onScroll`, both user-driven and
	 * programmatic) so the floating button tracks the selected rows as they
	 * move instead of pointing at a stale snapshot — see this file's
	 * `measureGutterAnchorRect` doc comment for why this can't just rely on
	 * Floating UI's own ancestor-scroll auto-tracking.
	 */
	refreshAnchorRect: () => void;
	/** Drops both selection sources and closes the floating button — call once the button's own action completes, or on Escape. */
	clearSelection: () => void;
};

/**
 * Resolves a selection's two boundary rows to the line range this feature
 * reports. Mirrors the walkthrough's own convention (`Location` is 1-based
 * in head/new content, see `packages/walkthrough/AGENTS.md`): a boundary on
 * the additions/context side already carries its head line number directly;
 * a boundary on the deletions side has no head equivalent at all (the line
 * doesn't exist in head).
 *
 * When both boundaries are on the deletions side, the whole selection has no
 * head presence — reporting old-side numbers is the only truthful choice.
 * When exactly one boundary is on the deletions side (the drag crossed a
 * change boundary), this collapses to the other boundary's own head line
 * rather than guessing which head line the deletion-side boundary "would
 * have been" — cheap to reason about, and never wrong, just less precise for
 * a drag that spans both removed and kept/added lines in one gesture.
 */
function resolveHeadRange(
	start: { line: number; side: SelectionSide },
	end: { line: number; side: SelectionSide },
): { startLine: number; endLine: number } {
	const startIsDeletion = start.side === "deletions";
	const endIsDeletion = end.side === "deletions";
	if (startIsDeletion === endIsDeletion) {
		// Both deletions (old-side numbers) or both head-side (already
		// consistent numbers) — either way, the pair is directly comparable.
		return {
			startLine: Math.min(start.line, end.line),
			endLine: Math.max(start.line, end.line),
		};
	}
	const headLine = startIsDeletion ? end.line : start.line;
	return { startLine: headLine, endLine: headLine };
}

/** Walks up from a selection boundary node to the nearest row element carrying `@pierre/diffs`' line-identity attributes (`data-line` on content spans, `data-column-number` on gutter cells — both mirror the same number and `data-line-type`, see `diff-view-theme.ts`'s doc comments on the shadow-DOM contract). */
function resolveRowElement(node: Node): Element | undefined {
	const element = node instanceof Element ? node : node.parentElement;
	return element?.closest("[data-line], [data-column-number]") ?? undefined;
}

function rowToBoundary(
	row: Element,
): { line: number; side: SelectionSide } | undefined {
	const raw =
		row.getAttribute("data-line") ?? row.getAttribute("data-column-number");
	if (raw === null) return undefined;
	const line = Number(raw);
	if (!Number.isFinite(line)) return undefined;
	const side: SelectionSide =
		row.getAttribute("data-line-type") === "change-deletion"
			? "deletions"
			: "additions";
	return { line, side };
}

/**
 * Finds the one active, non-collapsed selection across every rendered
 * item's shadow root, feature-detecting rather than assuming one engine's
 * behavior: this app has observed both a per-shadow-root `getSelection()`
 * (checked first, per item) and a plain `document.getSelection()` that
 * resolves directly into an open shadow tree's nodes when the whole
 * selection lives inside one (checked as the fallback). Which of the two
 * a given engine actually takes hasn't been confirmed on WKWebView
 * specifically — only that both codepaths exist and this function doesn't
 * assume in advance which one will fire.
 *
 * A selection whose two boundaries resolve to different items (a drag that
 * crossed a file boundary) returns `undefined` rather than a reference
 * clamped to one side — a reference the user didn't actually ask for is
 * worse than no button at all.
 */
function resolveActiveTextSelection(
	items: readonly { id: string; element: HTMLElement }[],
): { itemId: string; range: Range } | undefined {
	for (const item of items) {
		const shadowRoot = item.element.shadowRoot;
		const getRootSelection = (
			shadowRoot as unknown as { getSelection?: () => Selection | null }
		)?.getSelection;
		if (typeof getRootSelection !== "function") continue;
		const selection = getRootSelection.call(shadowRoot);
		if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
			return { itemId: item.id, range: selection.getRangeAt(0) };
		}
	}
	const selection = document.getSelection();
	if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
		return undefined;
	}
	const range = selection.getRangeAt(0);
	const root = range.commonAncestorContainer.getRootNode();
	const item = items.find((candidate) => candidate.element.shadowRoot === root);
	return item ? { itemId: item.id, range } : undefined;
}

/**
 * Presence-only marker `diff-selection-popover.tsx` sets on the floating
 * "Copy reference" popup's root node, spread there via
 * `diffSelectionPopupMarkerProps` below — checked by
 * `isEventOriginOnGutterOrPopup` to recognize a gesture landing inside that
 * popup.
 *
 * Deliberately not `data-slot="popover-popup"`, even though that string
 * happens to also land on this same node via `#/components/ui/popover.tsx`'s
 * styling convention. `data-slot` is shared UI's own labeling scheme, owned
 * by that module for its own consumers — matching against it here made this
 * selection-clearing check quietly break the moment `diff-selection-popover.tsx`
 * stopped rendering through the `PopoverPopup` wrapper that happened to set
 * it (nothing failed loudly; "Copy reference" just stopped working), and it
 * was over-broad besides: it would have treated a click inside *any* other
 * popover in the app as "inside this feature's popup" too. A dedicated
 * attribute, defined once and imported by both sides, means the two can't
 * drift apart again and doesn't reach into a module this feature doesn't own.
 */
const DIFF_SELECTION_POPUP_ATTRIBUTE = "data-diff-selection-popup";

/** Spread onto the floating "Copy reference" popup's root DOM node — see `DIFF_SELECTION_POPUP_ATTRIBUTE`'s doc comment. */
export const diffSelectionPopupMarkerProps = {
	[DIFF_SELECTION_POPUP_ATTRIBUTE]: "",
};

/**
 * Whether `event`'s true origin (see `isEventOriginOnGutter`'s doc comment
 * on why `composedPath()` rather than `event.target`) was the line-number
 * gutter or the floating popup itself.
 *
 * Used by `recomputeTextSelection` to decide whether "no active text
 * selection right now" also means "the gutter selection is stale, clear
 * it" — `@pierre/diffs`' own gutter-selection lifecycle (start, extend,
 * commit) is a separate, multi-callback process this function has no
 * visibility into moment-to-moment, so anything that could plausibly be
 * part of it (on the gutter) or is `Copy reference` itself must be left
 * alone entirely, not raced against.
 */
function isEventOriginOnGutterOrPopup(event: Event): boolean {
	if (isEventOriginOnGutter(event)) return true;
	for (const node of event.composedPath()) {
		if (!(node instanceof Element)) continue;
		if (node.hasAttribute(DIFF_SELECTION_POPUP_ATTRIBUTE)) return true;
	}
	return false;
}

/** Union of two `DOMRect`s — used to grow the gutter selection's anchor rect across every `[data-selected-line]` row `@pierre/diffs` paints for the range. */
function unionRect(a: DOMRect, b: DOMRect): DOMRect {
	const left = Math.min(a.left, b.left);
	const top = Math.min(a.top, b.top);
	const right = Math.max(a.right, b.right);
	const bottom = Math.max(a.bottom, b.bottom);
	return new DOMRect(left, top, right - left, bottom - top);
}

export function useDiffSelection<Metadata>({
	codeViewRef,
	resolveItemPath,
}: UseDiffSelectionOptions<Metadata>): UseDiffSelectionResult {
	const [gutterSelection, setGutterSelection] =
		useState<CodeViewLineSelection | null>(null);
	// Mirrors `gutterSelection`, updated synchronously alongside every
	// `setGutterSelection` call — `recomputeTextSelection` below reads this,
	// not the state variable, because it runs from a plain
	// `document.addEventListener` callback that can fire (via `pointerup`)
	// *within the same synchronous gesture* that `handleSelectedLinesChange`
	// already called `setGutterSelection` from, before React has re-rendered
	// and handed this effect a closure over the new value. Confirmed live:
	// a single click on the gutter logged `handleSelectedLinesChange` first,
	// then `recomputeTextSelection` observed `gutterSelection` still `null`
	// on the very same pointerup — reading the stale closure made this
	// module's own "clear a stale gutter selection" branch (below) fire for
	// every brand-new gutter click too, cancelling the reference before
	// `handleSelectedLinesChange`'s `pollUntilReady` ever got to set the
	// real one.
	const gutterSelectionRef = useRef<CodeViewLineSelection | null>(null);
	const [reference, setReference] = useState<DiffSelectionReference | null>(
		null,
	);
	const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
	// The text path's counterpart to `gutterSelectionRef` — the last `Range`
	// `recomputeTextSelection` resolved a reference from, kept around so
	// `refreshAnchorRect` can re-measure it fresh on a later scroll tick
	// instead of trusting a snapshot taken back when the selection was made.
	// A `Range`'s own boundary points track live DOM mutation on their own
	// (unlike a plain `DOMRect`), so `.getBoundingClientRect()` here always
	// reflects the text's *current* position for as long as its container
	// nodes stay mounted.
	const activeTextRangeRef = useRef<Range | null>(null);
	// Whether the gesture currently in progress started with a pointerdown
	// on the gutter — set on `pointerdown`, consulted (and reset) on the
	// matching `pointerup`. See `recomputeTextSelection`'s pointerup branch
	// for why this, not just that pointerup's own origin, decides whether a
	// gutter selection gets wiped: a drag that starts in the lane and ends
	// elsewhere must keep tracking pierre's own document-wide pointer
	// handling, not read as a stale selection left over from a previous
	// gesture.
	const gutterDragInProgressRef = useRef(false);
	const pendingGutterRectFrame = useRef<number | null>(null);

	/**
	 * Re-measures a gutter selection's anchor rect straight from the DOM —
	 * the union of every `[data-selected-line]` row `@pierre/diffs`
	 * currently has painted for `selection.id`. Returns `undefined` when
	 * that item isn't currently rendered at all (its file card scrolled far
	 * enough that `@pierre/diffs`' own virtualization dropped it) or hasn't
	 * painted the selected rows yet.
	 *
	 * Shared by `handleSelectedLinesChange`'s initial poll (a selection just
	 * appeared or changed) and `refreshAnchorRect` (the pane scrolled, same
	 * selection) — both need "where are this selection's rows *right now*,"
	 * never a value captured earlier. A virtual anchor built from a
	 * snapshotted rect can't track a scrolling pane; Base UI's Positioner
	 * only re-measures a *virtual* anchor's position when something asks it
	 * to (it has no real DOM node to watch via `ResizeObserver`, and its
	 * ancestor-scroll auto-tracking needs a `contextElement` this anchor
	 * doesn't have and can't stably keep, since the row backing it is
	 * exactly what virtualization recycles) — so both call sites exist to
	 * be that ask.
	 */
	const measureGutterAnchorRect = useCallback(
		(selection: CodeViewLineSelection): DOMRect | undefined => {
			const item = codeViewRef.current
				?.getInstance()
				?.getRenderedItems()
				.find((candidate) => candidate.id === selection.id);
			const shadowRoot = item?.element.shadowRoot;
			if (!shadowRoot) return undefined;
			const rows = shadowRoot.querySelectorAll("[data-selected-line]");
			if (rows.length === 0) return undefined;
			let rect: DOMRect | undefined;
			for (const row of rows) {
				const rowRect = row.getBoundingClientRect();
				rect = rect === undefined ? rowRect : unionRect(rect, rowRect);
			}
			return rect;
		},
		[codeViewRef],
	);

	const clearSelection = useCallback(() => {
		gutterSelectionRef.current = null;
		setGutterSelection(null);
		setReference(null);
		activeTextRangeRef.current = null;
		setAnchorRect(null);
		if (pendingGutterRectFrame.current !== null) {
			cancelAnimationFrame(pendingGutterRectFrame.current);
			pendingGutterRectFrame.current = null;
		}
		const activeSelection = document.getSelection();
		activeSelection?.removeAllRanges();
		for (const item of codeViewRef.current?.getInstance()?.getRenderedItems() ??
			[]) {
			const getRootSelection = (
				item.element.shadowRoot as unknown as {
					getSelection?: () => Selection | null;
				}
			)?.getSelection;
			getRootSelection?.call(item.element.shadowRoot)?.removeAllRanges();
		}
	}, [codeViewRef]);

	/**
	 * Re-measures `anchorRect` against whichever selection source is
	 * currently active, straight from the DOM — call on every `CodeView`
	 * scroll tick. Doesn't touch `reference`: the selection's *identity*
	 * survives a scroll even when its rows currently can't be found (the
	 * button just hides via `anchorRect` going `null` until they reappear).
	 */
	const refreshAnchorRect = useCallback(() => {
		if (gutterSelectionRef.current !== null) {
			const selection = gutterSelectionRef.current;
			const immediateRect = measureGutterAnchorRect(selection);
			if (immediateRect !== undefined) {
				setAnchorRect(immediateRect);
				return;
			}
			// Hide immediately rather than leave the button painting at a
			// stale position — but the rows might only be a frame away from
			// reappearing rather than gone for good: the scroll event that
			// brings a row's file back into `@pierre/diffs`' virtualized
			// window doesn't necessarily land in the same tick as its own
			// recycling of the pooled `<diffs-container>` back onto that
			// file, so a single synchronous check right here can race
			// pierre's own repaint (mirrors why `handleSelectedLinesChange`
			// polls for its *first* measurement instead of reading the DOM
			// inline). Bounded, so a selection that's scrolled away for
			// good just stays hidden once the window closes rather than
			// polling forever.
			setAnchorRect(null);
			pollUntilReady(() => {
				const rect = measureGutterAnchorRect(selection);
				if (rect === undefined) return false;
				setAnchorRect(rect);
				return true;
			}, pendingGutterRectFrame);
			return;
		}
		if (activeTextRangeRef.current === null) {
			setAnchorRect(null);
			return;
		}
		const rect = activeTextRangeRef.current.getBoundingClientRect();
		setAnchorRect(rect.width === 0 && rect.height === 0 ? null : rect);
	}, [measureGutterAnchorRect]);

	// The gutter (line-lane) path: `@pierre/diffs` already tracks drag state
	// and hands back typed boundaries (`range.side`/`endSide`), so this needs
	// no DOM inspection to resolve the line range — only to find the anchor
	// rect, and only once `@pierre/diffs` has actually painted
	// `[data-selected-line]` onto the row(s), which happens on the next
	// animation frame (`UniversalRenderingManager`'s `queueRender`), not
	// synchronously with this callback — hence `pollUntilReady` rather than
	// reading the DOM inline.
	const handleSelectedLinesChange = useCallback(
		(selection: CodeViewLineSelection | null) => {
			gutterSelectionRef.current = selection;
			setGutterSelection(selection);
			if (selection === null) {
				setReference(null);
				setAnchorRect(null);
				return;
			}
			// A new gutter drag supersedes any live text selection — only one
			// selection is ever "active" (see this module's doc comment).
			document.getSelection()?.removeAllRanges();
			activeTextRangeRef.current = null;

			const path = resolveItemPath(selection.id);
			if (path === undefined) {
				setReference(null);
				setAnchorRect(null);
				return;
			}
			const headRange = resolveHeadRange(
				{
					line: selection.range.start,
					side: selection.range.side ?? "additions",
				},
				{
					line: selection.range.end,
					side: selection.range.endSide ?? selection.range.side ?? "additions",
				},
			);
			pollUntilReady(() => {
				const rect = measureGutterAnchorRect(selection);
				if (rect === undefined) return false;
				setReference({
					path,
					startLine: headRange.startLine,
					endLine: headRange.endLine,
				});
				setAnchorRect(rect);
				return true;
			}, pendingGutterRectFrame);
		},
		[resolveItemPath, measureGutterAnchorRect],
	);

	// The text path: plain browser selection over code, which `@pierre/diffs`
	// never touches (`enableLineSelection` only intercepts pointer-downs on
	// the number column, see `use-diff-selection.ts`'s consumer for why).
	// `selectionchange` is the natural event for this, but its behavior
	// across an *open* shadow root's own selection (the WebKit path
	// `resolveActiveTextSelection` feature-detects for) isn't something to
	// assume without checking live — `pointerup`/`keyup` bubble out of an
	// open shadow root as ordinary composed events regardless of which
	// engine's Selection quirks apply, so those are the primary trigger here
	// and `selectionchange` only a secondary one (e.g. Cmd+A "Select All").
	useEffect(() => {
		// Records whether the gesture that's about to unfold started as a
		// gutter drag — see `gutterDragInProgressRef`'s doc comment. Has to
		// run on `pointerdown`, not be inferred later: by the time
		// `pointerup` fires, the pointer itself carries no memory of where
		// it went down, only where it is now.
		const handlePointerDown = (event: Event) => {
			gutterDragInProgressRef.current = isEventOriginOnGutter(event);
		};
		const recomputeTextSelection = (event: Event) => {
			const items =
				codeViewRef.current?.getInstance()?.getRenderedItems() ?? [];
			const active = resolveActiveTextSelection(items);
			if (active === undefined) {
				// No active text selection right now — but that alone
				// doesn't mean "clear everything": `@pierre/diffs`' own
				// gutter-selection lifecycle (start, extend, commit) is a
				// separate, multi-callback process this function has no
				// visibility into moment-to-moment, and this same
				// `pointerup` fires *during* it. Gate on where the event
				// actually originated instead of trying to track that
				// lifecycle's timing: a `pointerup` whose real origin (see
				// `isEventOriginOnGutterOrPopup`'s doc comment on why
				// `event.target` itself isn't trustworthy here) is the
				// gutter or the popup itself is either part of a gutter
				// selection in progress or `Copy reference` being clicked —
				// leave those alone.
				//
				// A drag that *started* in the gutter but has since moved
				// (and, for this pointerup, ends) outside it needs the same
				// treatment: `gutterDragInProgressRef` (set on this
				// gesture's own `pointerdown`) catches that case, since the
				// pointerup's own origin alone can't — pierre's
				// `InteractionManager` tracks such a drag document-wide
				// (`handleDocumentPointerMove`/`handleDocumentPointerUp`)
				// and keeps extending `[data-selected-line]` right up to
				// this same pointerup, confirmed live; wiping here would
				// undo a selection the user was still deliberately making,
				// which is exactly the "second gutter drag silently
				// produces zero selected lines" failure this module's
				// history already fixed once for the *other* mid-gesture
				// race (see the `onDismiss` doc comment in
				// `diff-selection-popover.tsx`).
				//
				// Anything else — code text (places a caret, no selection),
				// or a gesture that neither started nor is ending on the
				// gutter/popup — proves this pointerup isn't and can't be
				// part of that lifecycle, so any gutter selection still
				// showing is provably stale.
				// `selectionchange`/`keyup` have no equally reliable origin
				// signal (`selectionchange`'s target is `document`; a
				// gutter selection never has focus to begin with), so they
				// keep trusting `gutterSelectionRef` instead — safe here
				// since these aren't the events racing `@pierre/diffs`' own
				// multi-stage gutter callbacks the way `pointerup` is.
				if (event.type === "pointerup") {
					const wasGutterDrag = gutterDragInProgressRef.current;
					gutterDragInProgressRef.current = false;
					if (wasGutterDrag || isEventOriginOnGutterOrPopup(event)) return;
					gutterSelectionRef.current = null;
					setGutterSelection(null);
					setReference(null);
					activeTextRangeRef.current = null;
					setAnchorRect(null);
					return;
				}
				if (gutterSelectionRef.current === null) setReference(null);
				return;
			}
			const path = resolveItemPath(active.itemId);
			if (path === undefined) return;
			const startRow = resolveRowElement(active.range.startContainer);
			const endRow = resolveRowElement(active.range.endContainer);
			const start = startRow && rowToBoundary(startRow);
			const end = endRow && rowToBoundary(endRow);
			if (!start || !end) return;
			// A live text selection supersedes any gutter selection.
			if (gutterSelectionRef.current !== null) {
				gutterSelectionRef.current = null;
				setGutterSelection(null);
			}
			const headRange = resolveHeadRange(start, end);
			activeTextRangeRef.current = active.range;
			setReference({
				path,
				startLine: headRange.startLine,
				endLine: headRange.endLine,
			});
			setAnchorRect(active.range.getBoundingClientRect());
		};
		document.addEventListener("pointerdown", handlePointerDown);
		document.addEventListener("selectionchange", recomputeTextSelection);
		document.addEventListener("pointerup", recomputeTextSelection);
		document.addEventListener("keyup", recomputeTextSelection);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("selectionchange", recomputeTextSelection);
			document.removeEventListener("pointerup", recomputeTextSelection);
			document.removeEventListener("keyup", recomputeTextSelection);
		};
	}, [codeViewRef, resolveItemPath]);

	useEffect(
		() => () => {
			if (pendingGutterRectFrame.current !== null) {
				cancelAnimationFrame(pendingGutterRectFrame.current);
			}
		},
		[],
	);

	return {
		selectedLines: gutterSelection,
		onSelectedLinesChange: handleSelectedLinesChange,
		reference,
		anchorRect,
		refreshAnchorRect,
		clearSelection,
	};
}
