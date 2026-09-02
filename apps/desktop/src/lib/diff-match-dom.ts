/**
 * `@pierre/diffs` DOM-addressing primitives for keyword-search match
 * highlighting — pulled out of `diff-pane.tsx`/`use-diff-match-highlighting.ts`
 * since these are pure DOM queries with no React or highlighting-policy
 * involved, just the undocumented row-addressing contract `@pierre/diffs`
 * happens to expose. No React import here on purpose: everything is a plain
 * function over `Node`/`Element`/`Range`, unit-testable against a bare DOM.
 */
import type { DiffMatch } from "#/lib/diff-search";

/**
 * Match highlighting paints character ranges via the CSS Custom Highlight
 * API (`CSS.highlights` + `Highlight` + `Range`, `::highlight()`) instead of
 * wrapping matched text in new DOM elements — a `Range` can start and end
 * inside two different syntax-highlighted `<span>`s without needing to
 * split or otherwise touch them, which sidesteps both problems that come
 * with wrapping: reconciling raw character offsets against tokens that
 * split mid-match, and re-doing that surgery every time a virtualized row
 * is recycled. This is a single known engine (Tauri/WKWebView on macOS);
 * `Highlight`/`CSS.highlights` shipped in Safari 17.2. Still feature-detected
 * since this project pins no minimum macOS version.
 */
export const SUPPORTS_HIGHLIGHT_API =
	typeof CSS !== "undefined" &&
	"highlights" in CSS &&
	typeof Highlight !== "undefined";

/**
 * Locates one match's own rendered row inside a file item's shadow root.
 * `@pierre/diffs` stamps every row with `data-line` (the number shown in
 * that row's gutter) and `data-line-type` (`"change-deletion"` for a pure
 * removed line) — confirmed live, since neither is documented. A removed
 * row's `data-line` is its *old*-file number, which can coincide with some
 * other row's *new*-file number elsewhere in the same file, so matching on
 * `data-line-type` (and, for split `diffStyle`, which of `[data-deletions]`/
 * `[data-additions]` the row falls under) disambiguates.
 */
export function findMatchRowElement(
	root: ParentNode,
	side: DiffMatch["side"],
	rowLine: number,
): HTMLElement | undefined {
	const candidates = root.querySelectorAll(`[data-line="${rowLine}"]`);
	for (const candidate of candidates) {
		if (!(candidate instanceof HTMLElement)) continue;
		const isDeletionRow =
			candidate.getAttribute("data-line-type") === "change-deletion";
		if (side === "deletions" && !isDeletionRow) continue;
		if (side === "additions" && isDeletionRow) continue;
		if (side === "deletions" && candidate.closest("[data-additions]")) continue;
		if (side === "additions" && candidate.closest("[data-deletions]")) continue;
		return candidate;
	}
	return undefined;
}

/** Walks `root`'s text nodes in document order to find the node/local-offset pair `targetOffset` characters in — the position a `Range` boundary needs, since a match's character offset is relative to the row's whole rendered text, not any one token span inside it. */
function resolveTextPosition(
	root: Node,
	targetOffset: number,
): { node: Text; offset: number } | undefined {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let consumed = 0;
	for (
		let node = walker.nextNode() as Text | null;
		node !== null;
		node = walker.nextNode() as Text | null
	) {
		const length = node.data.length;
		if (targetOffset <= consumed + length) {
			return { node, offset: targetOffset - consumed };
		}
		consumed += length;
	}
	return undefined;
}

/** Builds the `Range` for one match's character span within its own row element — `undefined` if the row's rendered text is shorter than `offset + length` (shouldn't happen; the row's text always reconstructs the same stripped line text `diff-search.ts` matched against). */
export function buildMatchRange(
	rowElement: HTMLElement,
	offset: number,
	length: number,
): Range | undefined {
	const start = resolveTextPosition(rowElement, offset);
	const end = resolveTextPosition(rowElement, offset + length);
	if (start === undefined || end === undefined) return undefined;
	const range = new Range();
	range.setStart(start.node, start.offset);
	range.setEnd(end.node, end.offset);
	return range;
}

/**
 * Whether `event`'s true origin — not its retargeted `.target`, which
 * `@pierre/diffs`' open shadow roots rewrite to the shadow host for anything
 * that happened inside them (so a click deep inside one would otherwise look
 * identical to a click anywhere else on that file's card); `composedPath()`
 * isn't retargeted this way, so this walks that instead — carries any of
 * `@pierre/diffs`' row-identity attributes.
 */
function composedPathHasAttribute(
	event: Event,
	attributes: readonly string[],
): boolean {
	for (const node of event.composedPath()) {
		if (!(node instanceof Element)) continue;
		if (attributes.some((attribute) => node.hasAttribute(attribute))) {
			return true;
		}
	}
	return false;
}

/**
 * Whether `event`'s true origin was the line-number gutter (`data-column-number`
 * on a gutter cell, `data-gutter` on its container) — see
 * `composedPathHasAttribute`'s doc comment for why `composedPath()`, not
 * `.target`. Used to tell a gutter-started drag from a text/row one.
 */
export function isEventOriginOnGutter(event: Event): boolean {
	return composedPathHasAttribute(event, ["data-column-number", "data-gutter"]);
}

/**
 * Whether `event`'s true origin was any diff row — content (`data-line`) or
 * the gutter (`isEventOriginOnGutter`) — rather than surrounding chrome (a
 * file header, a "Reviewed" checkbox, a popover button) or the scroll
 * container's own native scrollbar (a scrollbar thumb's hit target is the
 * scrollable element itself, which never carries these attributes).
 */
export function isEventOriginOnDiffRow(event: Event): boolean {
	return (
		isEventOriginOnGutter(event) ||
		composedPathHasAttribute(event, ["data-line"])
	);
}

/**
 * Retries `attempt` once per animation frame until it reports success, or
 * the frame budget runs out — the shared shape behind both "scroll to an
 * item" (`diff-pane.tsx`'s `scrollWhenReady`) and "highlight the current
 * match" (`use-diff-match-highlighting.ts`), since both need to wait for a
 * virtualized item to actually mount before they can act on it. `frameRef`
 * is the caller's own pending-frame ref, so two independent pollers (e.g. a
 * scroll and a highlight update in flight at once) never cancel each
 * other's loop.
 */
export function pollUntilReady(
	attempt: () => boolean,
	frameRef: { current: number | null },
	frameLimit = 60,
): void {
	if (frameRef.current !== null) {
		cancelAnimationFrame(frameRef.current);
		frameRef.current = null;
	}
	let attempts = 0;
	const tick = () => {
		frameRef.current = null;
		if (attempt()) return;
		if (attempts < frameLimit) {
			attempts += 1;
			frameRef.current = requestAnimationFrame(tick);
		}
	};
	tick();
}
