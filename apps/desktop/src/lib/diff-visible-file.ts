/**
 * Scroll-driven file focus for the diff pane — deriving which file sits at
 * the top of `@pierre/diffs`' virtualized viewport from a `CodeView`
 * instance's own rendered items, so `DiffPane` can report it as the user
 * scrolls. A pure function over the instance's layout queries
 * (`getRenderedItems`/`getTopForItem`), no React involved — same shape as
 * `diff-match-dom.ts`'s DOM-addressing helpers, just over pierre's virtual
 * layout instead of the rendered DOM.
 */
import type { CodeView } from "@pierre/diffs";

/**
 * Slack (in px) for treating a rendered item's measured `top` as "at" the
 * viewport top rather than strictly above it — `scrollTop`/`top` can
 * disagree by a sub-pixel rounding amount even when an item is genuinely
 * flush with the top edge.
 */
const VIEWPORT_TOP_THRESHOLD_PX = 1;

/**
 * The id of the file "at the top of the viewport": the last rendered item
 * whose top has scrolled at or above `scrollTop`, not whichever item covers
 * the most of the viewport — a short file near the top of a long one would
 * otherwise "win" by area despite being mostly scrolled out of view. This
 * keeps scroll-driven selection consistent with `scrollToPath`, which lands
 * a file at the top (`align: "start"`) rather than centering it.
 *
 * Every item in `DiffPane`'s own `items` array is one file, keyed by its
 * path (`id: file.path`) — there's no other item type mixed in — so no
 * filtering by item type is needed here.
 *
 * Falls back to the item nearest the top from below when nothing has
 * scrolled past yet (e.g. the viewport is still above the first file).
 * `undefined` only when the pane has no rendered — or no yet-measured —
 * items at all.
 */
export function findTopVisibleItemId<Metadata>(
	viewer: Pick<CodeView<Metadata>, "getRenderedItems" | "getTopForItem">,
	scrollTop: number,
): string | undefined {
	let atOrAboveId: string | undefined;
	let atOrAboveTop = Number.NEGATIVE_INFINITY;
	let belowId: string | undefined;
	let belowTop = Number.POSITIVE_INFINITY;

	for (const item of viewer.getRenderedItems()) {
		const top = viewer.getTopForItem(item.id);
		if (top === undefined) continue;
		if (top <= scrollTop + VIEWPORT_TOP_THRESHOLD_PX) {
			if (top > atOrAboveTop) {
				atOrAboveTop = top;
				atOrAboveId = item.id;
			}
		} else if (top < belowTop) {
			belowTop = top;
			belowId = item.id;
		}
	}

	return atOrAboveId ?? belowId;
}
