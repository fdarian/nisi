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
 * Host class toggled per item in `onPostRender` while `diff-pane.tsx`'s
 * loading placeholder stands in for a file whose content hasn't resolved
 * yet. That placeholder's `file.contents` is real — a blank line per
 * estimated changed line, so `CodeView` reserves roughly the right height
 * before ever measuring it (see `loadingPlaceholderContents`) — so unlike
 * `DIFF_VIEWED_HOST_CLASS` this can't just dim a small, already-rendered
 * card: for a large file the reserved height can run to thousands of
 * pixels, and without this class a user who scrolls into the middle of it
 * would see nothing but blank numbered lines with no indication anything is
 * loading (the "Loading diff…" annotation only lives at line 1). The rules
 * below apply uniformly across the card's whole box regardless of scroll
 * position — no `position: sticky` needed — by dimming the host (same
 * mechanism as `DIFF_VIEWED_HOST_CLASS`) and hiding the line-number gutter
 * so the blank lines don't read as an empty file.
 */
export const DIFF_LOADING_HOST_CLASS = "nisi-diff-loading";

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

	/** See \`DIFF_LOADING_HOST_CLASS\`'s doc comment for why this needs to hold
	 * up across a whole (possibly very tall) card, not just a small one. */
	:host(.${DIFF_LOADING_HOST_CLASS}) {
		opacity: 0.6;
	}

	/* The blank placeholder lines have nothing to show, but their line
	 * numbers still count up to the file's real estimated length — hiding the
	 * gutter (not the numbers' text color, so no color choice could feel
	 * "on brand" for pure filler) keeps that from reading as an empty file. */
	:host(.${DIFF_LOADING_HOST_CLASS}) [data-gutter] {
		visibility: hidden;
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
	 * Hunk-separator pill override, against the library's own stable
	 * "data-separator" and "data-expand" attribute hooks (not CSS classes, so
	 * this survives minor version bumps better than most escape hatches
	 * would). With \`hunkSeparators: "line-info-basic"\` (see
	 * diff-code-view.tsx) @pierre/diffs renders the "N unchanged lines"
	 * control as a 32px band spanning the full diff width by default — see
	 * createSeparator.js and the \`[data-separator="line-info-basic"]\` rules
	 * in @pierre/diffs' style.js. The Linear reference this is matching
	 * renders that control as a small centered pill floating between hunks
	 * instead, so the shape is overridden here.
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
	 * live rendered pill (\`[data-separator="line-info-basic"]\`
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
		align-items: center;
		justify-content: center;
		height: 40px !important;
		background: transparent !important;
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
	 * additions-side gutter pair too, leaving only the deletions-side gutter
	 * one visible — but the wrapper override two rules up sets
	 * \`display: inline-flex !important\`, which (being !important) wins over
	 * those non-important native rules regardless of selector specificity and
	 * un-hides all four. That's the duplicate-pill bug: with nothing else
	 * scoping it, both the gutter and content instances end up visible in
	 * every column.
	 *
	 * A single element can't visually span both columns here — each column's
	 * code area (\`[data-code]\`) clips overflow (\`overflow: scroll clip\`,
	 * needed for horizontal scrolling of long lines), so nothing painted
	 * inside one column's DOM subtree can bleed into the other's, even via
	 * \`position: absolute\`/cqi-width tricks (verified against @pierre/diffs'
	 * own \`hunkSeparators: "line-info"\` split output, which fakes a
	 * "continuous" band by tiling two independently-sized same-color pieces
	 * across the column boundary, not by truly spanning one element across
	 * it — not reproducible for a rounded pill without visible seams). So
	 * instead of trying to span both columns, exactly one instance is kept —
	 * the deletions (left) column's content-side pill, since content is the
	 * meaningful width to center against, not the narrow number gutter — and
	 * the other three are hidden outright.
	 */
	[data-gutter] [data-separator="line-info-basic"] [data-separator-wrapper],
	[data-additions] [data-content] [data-separator="line-info-basic"] [data-separator-wrapper] {
		display: none !important;
	}

	[data-separator="line-info-basic"] [data-separator-wrapper] {
		position: static !important;
		inset-inline: auto !important;
		width: auto !important;
		height: auto !important;
		display: inline-flex !important;
		grid-template-columns: none !important;
		align-items: stretch;
		border-radius: 999px;
		border: 1px solid var(--border);
		background: var(--secondary);
		box-shadow: 0 1px 2px color-mix(in srgb, var(--color-black) 8%, transparent);
		overflow: clip;
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
	   this), revealed on hover of the pill — the "secondary affordance"
	   from the reference. Only renders at all when @pierre/diffs decides a
	   gap is "chunked" (large enough for separate up/down expand buttons),
	   so it won't appear on every pill — see createSeparator.js. */
	[data-separator="line-info-basic"] [data-expand-all-button] {
		border-left: 1px solid var(--border);
	}

	[data-separator="line-info-basic"] [data-separator-wrapper]:hover [data-expand-all-button] {
		display: flex !important;
	}
`;
