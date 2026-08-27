"use client";

/**
 * Owns both ways a user can select a range in the diff pane — dragging (or
 * clicking) the line-number gutter, which `@pierre/diffs` itself tracks via
 * `enableLineSelection`/`selectedLines`, and a plain click-drag over the code
 * text, which is native browser selection `@pierre/diffs` never sees — and
 * normalizes whichever is active to one shape: the file path, a head-relative
 * line range, and a client rect to anchor a floating action against. The
 * pane and the floating "Copy reference" button both consume that one shape;
 * neither needs to know two selection mechanisms exist.
 *
 * Only one selection is ever "active": starting a gutter drag clears any
 * live text selection and vice versa, so the pane never has to reconcile two
 * simultaneous highlights or show two floating buttons.
 */
import type { CodeViewLineSelection, SelectionSide } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { pollUntilReady } from "#/lib/diff-match-dom";

/** One resolved selection — the file it's in, its head-relative line range (see `resolveHeadRange`'s doc comment for what "head-relative" means when the selection touches removed lines), and the client rect to anchor the floating button against. */
export type DiffSelectionReference = {
	path: string;
	startLine: number;
	endLine: number;
	rect: DOMRect;
};

/** `relative/path.ts#L131-133` — repo-relative path plus a 1-based, inclusive line range. A single-line reference drops the range: `path.ts#L131`. */
export function formatSelectionReference(
	reference: DiffSelectionReference,
): string {
	return reference.startLine === reference.endLine
		? `${reference.path}#L${reference.startLine}`
		: `${reference.path}#L${reference.startLine}-${reference.endLine}`;
}

type UseDiffSelectionOptions<Metadata> = {
	/** The same `CodeViewHandle` ref passed to `<DiffCodeView ref>` — used to reach a selected item's rendered shadow root (for the gutter path's anchor rect) and to resolve which item id a native text selection landed in. */
	codeViewRef: React.RefObject<CodeViewHandle<Metadata> | null>;
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
	/** Drops both selection sources and closes the floating button — call on scroll, or once the button's own action completes. */
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
 * Whether `event`'s *true* origin (not its retargeted `.target`) was the
 * line-number gutter or the floating popup itself. `event.target`, read
 * from a `document`-level listener, is retargeted to the shadow host for
 * anything that happened inside `@pierre/diffs`' open shadow roots — so a
 * click deep in the gutter would otherwise look identical to a click
 * anywhere else on that file's card. `event.composedPath()` isn't
 * retargeted this way; it carries the real path from the deepest element
 * outward, open-shadow-boundary or not, so this checks that instead.
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
	for (const node of event.composedPath()) {
		if (!(node instanceof Element)) continue;
		if (
			node.hasAttribute("data-column-number") ||
			node.hasAttribute("data-gutter")
		) {
			return true;
		}
		if (node.getAttribute("data-slot") === "popover-popup") return true;
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
	const pendingGutterRectFrame = useRef<number | null>(null);

	const clearSelection = useCallback(() => {
		gutterSelectionRef.current = null;
		setGutterSelection(null);
		setReference(null);
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
				return;
			}
			// A new gutter drag supersedes any live text selection — only one
			// selection is ever "active" (see this module's doc comment).
			document.getSelection()?.removeAllRanges();

			const path = resolveItemPath(selection.id);
			if (path === undefined) {
				setReference(null);
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
				const item = codeViewRef.current
					?.getInstance()
					?.getRenderedItems()
					.find((candidate) => candidate.id === selection.id);
				const shadowRoot = item?.element.shadowRoot;
				if (!shadowRoot) return false;
				const rows = shadowRoot.querySelectorAll("[data-selected-line]");
				if (rows.length === 0) return false;
				let rect: DOMRect | undefined;
				for (const row of rows) {
					const rowRect = row.getBoundingClientRect();
					rect = rect === undefined ? rowRect : unionRect(rect, rowRect);
				}
				if (rect === undefined) return false;
				setReference({
					path,
					startLine: headRange.startLine,
					endLine: headRange.endLine,
					rect,
				});
				return true;
			}, pendingGutterRectFrame);
		},
		[resolveItemPath, codeViewRef],
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
				// leave those alone. Anything else — code text (places a
				// caret, no selection), or truly outside the CodeView
				// (the sidebar, the PR header, a tab) — proves this gesture
				// isn't and can't become part of that lifecycle, so any
				// gutter selection still showing is provably stale.
				// `selectionchange`/`keyup` have no equally reliable origin
				// signal (`selectionchange`'s target is `document`; a
				// gutter selection never has focus to begin with), so they
				// keep trusting `gutterSelectionRef` instead — safe here
				// since these aren't the events racing `@pierre/diffs`' own
				// multi-stage gutter callbacks the way `pointerup` is.
				if (event.type === "pointerup") {
					if (isEventOriginOnGutterOrPopup(event)) return;
					gutterSelectionRef.current = null;
					setGutterSelection(null);
					setReference(null);
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
			setReference({
				path,
				startLine: headRange.startLine,
				endLine: headRange.endLine,
				rect: active.range.getBoundingClientRect(),
			});
		};
		document.addEventListener("selectionchange", recomputeTextSelection);
		document.addEventListener("pointerup", recomputeTextSelection);
		document.addEventListener("keyup", recomputeTextSelection);
		return () => {
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
		clearSelection,
	};
}
