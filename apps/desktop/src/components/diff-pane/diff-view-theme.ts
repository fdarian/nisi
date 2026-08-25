/**
 * `@pierre/diffs` renders into a shadow root, same as `@pierre/trees` (see
 * `files-sidebar/tree-shadow-dom.ts`) — but its escape hatch is nicer: rather
 * than patching a `<style>` into the shadow root after the fact, `unsafeCSS`
 * is injected into the shadow root *at construction*, so a plain `:host()`
 * class selector works for per-item styling (`nisi-diff-viewed` below, set
 * imperatively via `onPostRender` — see `diff-pane.tsx`). Nothing here needs
 * runtime DOM patching. And unlike `--trees-*-override`, `--diffs-*` custom
 * properties can just be assigned `var(--font-mono)` etc. directly inside
 * `:host {}` — custom properties inherit through the shadow boundary from
 * the outer document, so no inline style on the light-DOM host is needed
 * either.
 */
import type { CodeViewLayout } from "@pierre/diffs";
import { cn } from "#/lib/utils";

export const DIFF_VIEW_THEME = {
	dark: "github-dark",
	light: "github-light",
} as const;

export const diffHighlighterOptions = {
	maxLineDiffLength: 2000,
	theme: DIFF_VIEW_THEME,
	tokenizeMaxLineLength: 20_000,
	useTokenTransformer: false,
};

export const diffCodeViewLayout: CodeViewLayout = {
	gap: 12,
	paddingBottom: 36,
	paddingTop: 0,
};

export const diffItemMetrics = {
	diffHeaderHeight: 44,
	/**
	 * Must equal the rendered height of `[data-separator="line-info-basic"]`
	 * in `diffViewUnsafeCSS` below — see the comment on that rule for why.
	 */
	hunkSeparatorHeight: 40,
};

/** Host class toggled per item in `onPostRender` when the file is Reviewed. */
export const DIFF_VIEWED_HOST_CLASS = "nisi-diff-viewed";

/**
 * `::highlight()` rules for keyword-search matches, painted via the CSS
 * Custom Highlight API (`CSS.highlights`, `diff-pane.tsx`) instead of
 * wrapping matched text in DOM elements — a `Range` can span whatever
 * syntax-highlighted `<span>`s a match happens to cross without needing to
 * split or reconcile them. Highlight *names* are per-`DiffPane`-instance
 * (`useId()`-derived, passed in here) rather than one fixed name, since
 * `CSS.highlights` is a single document-global registry and more than one
 * `DiffPane` can be mounted at once (one per open PR tab) — a fixed name
 * would let a background tab's search silently overwrite the active tab's
 * highlights. `current`'s rule doesn't need higher specificity to win over
 * `all`'s for a range in both sets — `diff-pane.tsx` gives it a higher
 * `Highlight.priority` instead, since `::highlight()` layering is resolved
 * by priority, not selector specificity.
 */
export function diffSearchHighlightCSS(names: {
	all: string;
	current: string;
}): string {
	return `
		::highlight(${names.all}) {
			background-color: color-mix(in srgb, var(--color-yellow-500) 35%, transparent);
		}

		::highlight(${names.current}) {
			background-color: var(--color-orange-500);
			color: var(--color-black);
		}
	`;
}

/**
 * The card's top edge — shared by `DiffFileHeader` (Files Changed,
 * `diff-file-header.tsx`) and `ReferenceLocationHeader` (the walkthrough
 * reference pane, `reference-pane.tsx`), the two `renderCustomHeader`
 * implementations that slot into a `CodeView` item built with
 * `diffCardChromeCSS` below as its `extraCSS`. Height is not a style choice:
 * `h-11` (44px) must equal `diffItemMetrics.diffHeaderHeight` above —
 * `stickyHeaders` (`buildDiffCodeViewOptions`, `diff-code-view.tsx`) never
 * measures a header's real DOM height, it trusts that config number for the
 * sticky container's own CSS offset and for sizing its virtualized render
 * buffer. Letting a header's real height drift from 44px — content
 * wrapping, a badge some rows have and others don't — feeds pierre a wrong
 * offset: the sticky header stops covering content a few pixels early or
 * late, and the buffer window sizes itself off the same wrong number (a
 * scroll stutter that stalls a frame then jumps). Both consumers keep their
 * row single-line (`truncate` on the path, `items-center`) so 44px is safe
 * to hard-code rather than measure.
 *
 * `bg-background`, not `bg-card`: the whole card tracks the surrounding
 * panel's tone — `--card` is measurably lighter than `--background` in dark
 * mode (index.css) — so the header, the diff body under it
 * (`diffViewUnsafeCSS`'s `--diffs-*-bg`) and, for Files Changed, the
 * `<diffs-container>` behind it (`diff-pane.tsx`) all resolve to the same
 * surface, and `border` reads as a seam drawn on it rather than a change of
 * tone. It carries its own opaque background because `stickyHeaders` scrolls
 * the diff body underneath it.
 *
 * `collapsed` rounds all four corners when there's no body left under the
 * header to round off separately — Files Changed's collapsed file card.
 * Otherwise only the top two, leaving the bottom two to `diffCardChromeCSS`'s
 * `pre` rule; the reference pane has no collapsed state, so it always passes
 * `false`.
 */
export function diffCardHeaderClassName(collapsed: boolean): string {
	return cn(
		"h-11 border bg-background",
		collapsed ? "rounded-xl" : "rounded-t-xl",
	);
}

/**
 * The card's left/right/bottom edge, appended to `diffViewUnsafeCSS` by
 * both the Files Changed pane and the walkthrough reference pane
 * (`diff-pane.tsx` / `reference-pane.tsx`). Its top edge is the header's
 * (`diffCardHeaderClassName` above), and that split is the whole point:
 * `stickyHeaders: true` pins the header to the *pane's* top while the
 * `<diffs-container>` host keeps scrolling, so any edge drawn on the host runs
 * straight past the pinned header's rounded top corners and the card stops
 * looking like a card the moment you scroll into it. Drawing the top edge on
 * the one element that stays put keeps the card a card at any scroll position.
 *
 * An inset ring rather than a `border` because it must not add height:
 * `CodeView` computes every item's box from line counts and `itemMetrics`
 * (`diffItemMetrics` above) and never measures the rendered result — it
 * console-errors when its sticky container disagrees by even 1px. Only three
 * sides: the seam under the header is the header's own `border-b`, which is
 * the one that stays put once it's pinned.
 */
export const diffCardChromeCSS = `
	/**
	 * A rounded corner has to be *painted*, not cut out: everything stacked
	 * behind a pinned header — the \`<pre>\`, whose box runs right past it, and
	 * the host — is an opaque full-width rectangle at that scroll position, so
	 * a corner that merely clips the header away reveals a hard square of
	 * \`--diffs-bg\` instead of the surface the card sits on.
	 *
	 * \`[data-diffs-header]\` is @pierre/diffs' own wrapper around the
	 * \`<slot>\` our header renders into: header-sized, pinned, and painted
	 * above the \`<pre>\`. Filling it with the pane's own surface turns it into
	 * the backdrop the header's rounded corners cut into — so they read as
	 * corners at any scroll position, and in any state, without this having to
	 * know whether the card is collapsed.
	 *
	 * \`--pane-surface\` is declared by \`app-shell.tsx\` (\`INSET_PANE_CLASS\`)
	 * and reaches here by inheriting through the shadow boundary, the same way
	 * \`diffViewUnsafeCSS\`'s \`--font-mono\` etc. do.
	 */
	[data-diffs-header] {
		background-color: var(--pane-surface, var(--diffs-bg));
	}

	/**
	 * An overlay, not a \`border\` and not an inset ring on the \`<pre>\` itself.
	 * A \`border\` would add height, and \`CodeView\` derives every item's box
	 * from line counts and \`itemMetrics\` (\`diffItemMetrics\` above) rather
	 * than measuring — the 1px would accumulate down the list, and the
	 * mismatch check that would have caught it is behind a dev-build flag we
	 * don't set. An inset \`box-shadow\` paints *under* an element's children,
	 * and the \`<code>\` inside covers the \`<pre>\` edge to edge with its own
	 * opaque background, so the sides simply never showed.
	 *
	 * Anchored to the \`<pre>\` rather than the \`<code>\`: \`[data-code]\` is
	 * the horizontal scroll container for long lines, so an overlay inside it
	 * would slide away with the content.
	 */
	pre {
		border-radius: 0 0 var(--radius-xl) var(--radius-xl);
		position: relative;
	}

	pre::after {
		content: "";
		position: absolute;
		inset: 0;
		z-index: 4;
		pointer-events: none;
		border: 1px solid var(--border);
		border-top: 0;
		border-radius: inherit;
	}
`;

export const diffViewUnsafeCSS = `
	:host {
		--diffs-font-family: var(--font-mono);
		--diffs-header-font-family: var(--font-sans);
		--diffs-font-size: 12.5px;
		--diffs-line-height: 20px;
		/**
		 * Intentionally the panel's own \`--background\`, not \`--code\` (which
		 * tracks \`--card\` — see index.css). \`--code\` is what the pierre
		 * theme background var is *named* for, but using it here made every
		 * file's diff body render on a visibly different surface than the
		 * Files Changed pane around it (\`--card\` vs \`--background\` diverge in
		 * dark mode — \`--card\` is a touch lighter). The \`<diffs-container>\`
		 * itself (\`diff-pane.tsx\`'s \`[&_diffs-container]\` classes) and the
		 * header (\`diff-file-header.tsx\`) track \`--background\` for the same
		 * reason; the card reads as a card through its border and shadow, not
		 * through a distinct surface tone.
		 */
		--diffs-light-bg: var(--background);
		--diffs-dark-bg: var(--background);
		--diffs-bg-selection-override: color-mix(in srgb, var(--color-blue-500) 30%, transparent);
		--diffs-bg-selection-number-override: color-mix(in srgb, var(--color-blue-500) 42%, transparent);
	}

	:host(.${DIFF_VIEWED_HOST_CLASS}) {
		opacity: 0.55;
	}

	:host(.${DIFF_VIEWED_HOST_CLASS}:hover) {
		opacity: 0.85;
	}

	/**
	 * The sticky file header (\`stickyHeaders: true\`, see diff-code-view.tsx)
	 * ships an opaque background already (\`[data-diffs-header][data-sticky] {
	 * z-index: 1; background-color: var(--diffs-bg); position: sticky; top: 0
	 * }\` — verified in @pierre/diffs' style.js), but its z-index (1) is lower
	 * than several row-level elements that scroll underneath it — notably
	 * \`[data-gutter] { z-index: 3 }\`, the line-number column. Since z-index
	 * only orders paint within the *same* stacking context and both live
	 * directly under the shadow root, that inversion lets a scrolled row's
	 * gutter paint on top of the sticky header instead of being covered by
	 * it: the header goes translucent-looking and the first covered line's
	 * number/content pokes through. Bumped past every z-index @pierre/diffs'
	 * own stylesheet uses (checked style.js — the highest is 4, a merge
	 * -conflict resolution handle irrelevant to this pane) so the header
	 * reliably paints above any row content, not just the gutter.
	 */
	[data-diffs-header][data-sticky] {
		z-index: 5;
	}

	/**
	 * Hunk-separator band override, against the library's own stable
	 * "data-separator" and "data-expand" attribute hooks (not CSS classes, so
	 * this survives minor version bumps better than most escape hatches
	 * would). With \`hunkSeparators: "line-info-basic"\` (see
	 * diff-code-view.tsx) @pierre/diffs already renders the "N unchanged
	 * lines" control as a full-width, left-aligned band by default — see
	 * createSeparator.js and the \`[data-separator="line-info-basic"]\` rules
	 * in @pierre/diffs' style.js — so this override only reshapes its fill
	 * and repositions its expand affordance; it does not need to fight the
	 * library's own layout the way a centered-pill shape would (an earlier
	 * version of this file did exactly that — see git history — and hit a
	 * cascade of composing/alignment problems specific to forcing a
	 * pane-centered shape out of per-column markup; a design reference
	 * settled on matching that per-column markup instead, band per column,
	 * left-aligned, so most of that machinery is gone here).
	 *
	 * The height below is deliberately a fixed pixel value, not \`auto\` — and
	 * it is NOT a free choice: \`CodeView\` never measures a rendered item, it
	 * computes every item's \`top\` from \`itemMetrics\` alone (see
	 * \`diffItemMetrics\` above), and for a hunk separator specifically
	 * \`VirtualizedFileDiff.reconcileHeights()\` can't correct that estimate
	 * later either — it only remeasures diff items that carry line
	 * annotations, which a separator never does. A standing few-pixel error
	 * here silently shifts the computed position of every item below it, and
	 * is what caused scroll to visibly jump/stutter as different files became
	 * the virtualizer's scroll anchor mid-gesture. So this height and
	 * \`hunkSeparatorHeight\` in \`diffItemMetrics\` are a matched pair — change
	 * one, change the other — and the value itself must be measured from the
	 * live rendered band (\`[data-separator="line-info-basic"]\`
	 * \`.getBoundingClientRect().height\` in a browser), not computed from the
	 * padding/font-size below, since flex/line-height rounding doesn't
	 * reliably match hand arithmetic. \`!important\` is deliberate and
	 * contained to this one block — @pierre/diffs never uses \`!important\` in
	 * its own stylesheet (verified against its shipped style.js), so this
	 * doesn't need to chase its selector specificity either. If a
	 * @pierre/diffs upgrade changes that markup, this is the one place to
	 * update — and re-measure.
	 */
	[data-separator="line-info-basic"] {
		display: flex;
		height: 40px !important;
		background: transparent !important;
	}

	/**
	 * Query container for the \`cqw\` values below, on \`<pre>\` rather than
	 * \`[data-code]\` (the actual \`overflow: scroll\` element one level down):
	 * \`[data-code]\`'s grid columns (\`var(--diffs-grid-number-column-width)
	 * minmax(0, 1fr)\`, gutter + content) use *intrinsic* (min/max-content)
	 * sizing, and containing \`[data-code]\` itself was verified broken live
	 * in \`bun dev --browser\` — both tracks collapsed to \`[data-code]\`'s full
	 * width instead of their real split. \`<pre>\` isn't a grid (nothing to
	 * distribute) and already tracks the same width, since \`[data-code]\`'s
	 * scrollable overflow clips at its own boundary rather than growing
	 * \`<pre>\`. \`container-type: inline-size\` implies \`contain: layout\`,
	 * which makes \`<pre>\` a new stacking context for its descendants —
	 * checked against style.js that none of them need to compete in z-order
	 * with anything *outside* \`<pre>\` except
	 * \`[data-diffs-header][data-sticky]\` (z-index 5, bumped by the rule
	 * above), and that's unaffected since \`<pre>\` itself carries no z-index
	 * either before or after this change.
	 *
	 * In split, \`<pre>\` is the *pane's* container (it wraps both columns —
	 * confirmed live: its width equals the deletions and additions columns'
	 * widths summed), not either column's individually, so \`cqw\` values
	 * below need a fraction of it per column rather than \`100cqw\` — see the
	 * split-specific rule further down.
	 */
	pre {
		container-type: inline-size;
	}

	/**
	 * Split (side-by-side) layout renders FOUR separator elements per gap, not
	 * one: @pierre/diffs' DiffHunksRenderer calls \`pushSeparator\` once for
	 * "deletions" and once for "additions" (DiffHunksRenderer.js), and each of
	 * those pushes into *both* the line-number gutter's AST and the code
	 * content's AST — confirmed by inspecting the rendered shadow DOM (4
	 * \`[data-separator="line-info-basic"]\` nodes per gap: one under
	 * \`[data-gutter]\` and one under \`[data-content]\`, in each of the
	 * \`[data-deletions]\`/\`[data-additions]\` columns). @pierre/diffs' own
	 * stylesheet hides the content-side pair by default
	 * (\`[data-content] [data-separator-wrapper] { display: none }\`) and the
	 * additions-side gutter pair too, leaving only the deletions-side (or
	 * unified's single) gutter band visible — but the wrapper override further
	 * down sets \`display: flex !important\`, which (being !important) wins
	 * over those non-important native rules regardless of selector
	 * specificity and un-hides all four.
	 *
	 * The gutter/content duplication is a genuine duplicate — same text,
	 * same gap — so the content-side pair stays suppressed below, same as
	 * before. The deletions/additions duplication is not: each column wants
	 * its *own* band now (a design reference settled on two independent
	 * full-width bands, left-aligned, rather than one pane-centered pill
	 * straddling both — see the base rule's comment above), so both
	 * gutter-side instances stay visible and are sized independently to
	 * their own column's width by the split-specific rule below, with no
	 * composing or cross-column alignment needed.
	 */
	[data-content] [data-separator="line-info-basic"] [data-separator-wrapper] {
		display: none !important;
	}

	/**
	 * Sizes the band to the *column's* visible width, not \`[data-gutter]\`'s
	 * own ~2-4ch track. \`width: 100cqw\` sizes the row to \`<pre>\`'s full
	 * width; \`margin-right: -100cqw\` cancels that same width's contribution
	 * back out of \`[data-gutter]\`'s own \`minmax(min-content, max-content)\`
	 * track — without it, verified live that \`[data-gutter]\`'s column
	 * inflates to match the row's width, corrupting the gutter/content split
	 * the same way containing \`[data-code]\` directly did above. No
	 * \`position\` override needed: \`[data-gutter]\` is already \`position:
	 * sticky; left: 0\` in @pierre/diffs' own stylesheet, so an ordinary
	 * (\`position: static\`) child inherits that pinned position for free —
	 * the band stays put against the column's visible left edge while the
	 * user scrolls a long line horizontally, instead of scrolling away with
	 * the content.
	 *
	 * \`100cqw\` is correct as the default because in unified \`<pre>\` *is*
	 * the one column (no \`[data-deletions]\`/\`[data-additions]\` wrapper
	 * exists there at all — confirmed live). Split overrides it below.
	 */
	[data-gutter] [data-separator="line-info-basic"] {
		width: 100cqw;
		margin-right: -100cqw;
	}

	/**
	 * Split halves that \`100cqw\` box to \`50cqw\` — split is always exactly
	 * \`1fr 1fr\` (\`[data-diff-type="split"][data-overflow="scroll"]
	 * { grid-template-columns: 1fr 1fr }\` in style.js, verified live to
	 * render the two columns exactly equal-width), so half of \`<pre>\`'s
	 * width is one column's width. \`margin-right\` follows the same \`50cqw\`
	 * to keep canceling the row's own width contribution (see the rule
	 * above). Unlike the pane-centered version this replaced, neither column
	 * needs an x-shift to line up with the other — each one independently
	 * fills its own column, full stop.
	 */
	[data-deletions] [data-gutter] [data-separator="line-info-basic"],
	[data-additions] [data-gutter] [data-separator="line-info-basic"] {
		width: 50cqw;
		margin-right: -50cqw;
	}

	/**
	 * The band itself: fills the sized-and-anchored row above edge to edge
	 * (\`width\`/\`height: 100%\`, no border/radius/shadow — a flush full-width
	 * fill, not a floating pill) with a subtle background, per the design
	 * reference. \`position: static\`/\`inset-inline: auto\` cancel
	 * @pierre/diffs' own absolute positioning of this element (its native
	 * layout assumes it's *not* meant to fill an outer row the way this
	 * override uses it); \`grid-template-columns: none\` cancels a
	 * \`display: grid\` variant the library applies in some configurations,
	 * neither of which this flex-based layout needs. \`!important\` for the
	 * same reason as the base rule above — @pierre/diffs' own non-important
	 * rules for this element shouldn't need chasing on specificity or
	 * injection order.
	 *
	 * \`[data-separator-wrapper]\` is @pierre/diffs' own interactive element —
	 * the one it wires click/hover handlers to — so making *it* the
	 * full-width band, rather than a small pill centered inside a wider row,
	 * is what makes the whole band clickable and hoverable natively, with no
	 * extra JS: verified live that clicking anywhere across the band's width
	 * (not just on the expand icon) expands the gap, in both diff styles.
	 */
	[data-separator="line-info-basic"] [data-separator-wrapper] {
		position: static !important;
		inset-inline: auto !important;
		width: 100% !important;
		height: 100% !important;
		display: flex !important;
		grid-template-columns: none !important;
		align-items: center;
		background: var(--secondary);
	}

	/**
	 * Left-aligned text, expand icon pinned to the band's far right end —
	 * the reference this matches puts the primary (always-visible) expand
	 * affordance at the end of the band, not immediately after the text the
	 * way @pierre/diffs' own DOM order has it (\`[data-expand-button]\` first,
	 * confirmed live). \`order\` re-sequences the three children visually
	 * without touching that DOM order: text, then the hover-only "expand
	 * all" button, then the primary up/down/both chevron last.
	 * \`margin-left: auto\` on that last item absorbs all remaining flex
	 * space *before* it specifically, pushing it (and only it, being last)
	 * flush against the band's right edge regardless of how much text
	 * precedes it — applying the same margin to the first-ordered item
	 * instead would right-align the whole row's content, which isn't what's
	 * wanted here.
	 *
	 * \`:not([data-expand-all-button])\` excludes the "expand all" button,
	 * which also carries \`[data-expand-button]\` (confirmed live) but needs
	 * its own, earlier \`order\` — see below.
	 */
	[data-separator="line-info-basic"] [data-separator-content] {
		order: 1;
	}

	[data-separator="line-info-basic"] [data-expand-button]:not([data-expand-all-button]) {
		order: 3;
		margin-left: auto;
	}

	[data-separator="line-info-basic"] [data-expand-button],
	[data-separator="line-info-basic"] [data-separator-content] {
		background: transparent !important;
		border: none !important;
		border-radius: 0 !important;
		min-width: 0 !important;
		height: auto !important;
		padding: 5px 8px;
	}

	[data-separator="line-info-basic"] [data-expand-button] {
		color: var(--muted-foreground);
	}

	[data-separator="line-info-basic"] [data-expand-button]:hover {
		color: var(--foreground);
		background: color-mix(in srgb, var(--foreground) 8%, transparent) !important;
	}

	[data-separator="line-info-basic"] [data-separator-content] {
		color: var(--muted-foreground);
		font-family: var(--diffs-header-font-family);
		font-size: 11px;
	}

	/* Hidden by default (@pierre/diffs already ships \`display: none\` for
	   this), revealed on hover of the band — the "secondary affordance"
	   from the reference. Only renders at all when @pierre/diffs decides a
	   gap is "chunked" (large enough for separate up/down expand buttons),
	   so it won't appear on every band — see createSeparator.js.
	   \`order: 2\` (base rule two above) keeps it between the text and the
	   primary chevron rather than @pierre/diffs' own DOM-order position
	   right after the text. */
	[data-separator="line-info-basic"] [data-expand-all-button] {
		order: 2;
		border-left: 1px solid var(--border);
	}

	[data-separator="line-info-basic"] [data-separator-wrapper]:hover [data-expand-all-button] {
		display: flex !important;
	}

	/**
	 * Split-only: collapses the label/chevron duplication described above
	 * (each column renders its own full copy of "N unmodified lines" and
	 * the expand chevron) down to what the design reference asks for — the
	 * label rendered once, in the deletions (left) column, and the expand
	 * chevron rendered once, pinned to the additions (right) column's far
	 * right edge, which in split is also the pane's own far right edge.
	 * Reading across both columns: one label, one chevron, with the
	 * library's own column divider passing through the middle of what reads
	 * as a single band.
	 *
	 * Hides the *content* (\`[data-separator-content]\`/\`[data-expand-button]\`),
	 * never \`[data-separator-wrapper]\` itself — the wrapper is what carries
	 * the fill and the click handler (see its own rule above), so both
	 * columns stay exactly as clickable and exactly as filled as they were
	 * before this block; only the redundant text/button inside one column
	 * disappears.
	 *
	 * \`[data-deletions]\`/\`[data-additions]\` don't exist in unified (see the
	 * comment on the split-halving rule above) — this whole block is
	 * unreachable there, so unified's single label-left/chevron-right band
	 * is untouched.
	 *
	 * The hover-reveal rule for \`[data-expand-all-button]\` just above
	 * outspecifies a plain \`[data-deletions] ... [data-expand-button]\`
	 * selector (four attribute/pseudo selectors vs three), so hiding it in
	 * the deletions column needs its own \`:hover\`-qualified rule to match —
	 * otherwise hovering the deletions band would re-reveal a chevron there
	 * on "chunked" gaps, the one state the plain rule alone doesn't reach.
	 */
	[data-deletions] [data-separator="line-info-basic"] [data-expand-button] {
		display: none !important;
	}

	[data-deletions] [data-separator="line-info-basic"] [data-separator-wrapper]:hover [data-expand-all-button] {
		display: none !important;
	}

	[data-additions] [data-separator="line-info-basic"] [data-separator-content] {
		display: none !important;
	}
`;
