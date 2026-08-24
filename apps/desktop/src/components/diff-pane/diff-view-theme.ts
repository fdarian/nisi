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
	 * unified's single) gutter pill visible — but the wrapper override two
	 * rules down sets \`display: inline-flex !important\`, which (being
	 * !important) wins over those non-important native rules regardless of
	 * selector specificity and un-hides all four. That's the duplicate-pill
	 * bug: with nothing else scoping it, both the gutter and content
	 * instances end up visible in every column.
	 *
	 * Neither column alone is "the pane" the pill should center on — it's
	 * both together — so both gutter-side instances stay visible and
	 * *compose* into one pill spanning the boundary, instead of picking a
	 * single surviving instance the way the three-of-four duplicates above
	 * are resolved: each column's code area (\`[data-code]\`) clips overflow
	 * (\`overflow: scroll clip\`, needed for horizontal scrolling of long
	 * lines) at its own edge, so a full-pane-width (\`100cqw\`) copy of the
	 * pill rendered in *each* column, both positioned at the same
	 * pane-absolute offset, has its left half clipped away by the deletions
	 * column's own boundary and its right half clipped away by the
	 * additions column's — leaving exactly one visible half in each column,
	 * which line up into a single seamless pill because both copies are
	 * pixel-identical content at a pixel-identical position. (An earlier
	 * version of this fix rejected spanning both columns, on the reasoning
	 * that @pierre/diffs' own \`hunkSeparators: "line-info"\` split output
	 * fakes a "continuous" band by tiling two *independently-sized*
	 * same-color pieces across the boundary — true for that case, but this
	 * is two *identically-sized, identically-positioned* copies clipped by
	 * their own columns instead, which composes without a seam.)
	 *
	 * That pane-absolute offset comes for free from \`[data-gutter]\` already
	 * being \`position: sticky; left: 0\` in @pierre/diffs' own stylesheet —
	 * an ordinary (\`position: static\`) child inherits that pinned position,
	 * in the resting state and while scrolling alike (see the width rule
	 * below for how the additions-side copy is shifted to line up with the
	 * deletions-side one despite starting from a different column). A child
	 * of \`[data-content]\` doesn't get this for free — its own static
	 * position starts one gutter-width to the right of \`[data-code]\`'s
	 * edge, so an earlier version of this fix that made \`[data-content]\`'s
	 * child the sticky element only reached dead-center after the user
	 * scrolled past that width; before that, which is most files most of
	 * the time, the pill sat visibly off-center at \`scrollLeft: 0\` — the
	 * resting state nearly everyone sees. Verified live, both diff styles.
	 */
	[data-content] [data-separator="line-info-basic"] [data-separator-wrapper] {
		display: none !important;
	}

	/**
	 * Pane-centering fix, on the surviving (gutter-side) instance(s).
	 * \`width: 100cqw\` sizes the row to \`<pre>\`'s full width instead of
	 * \`[data-gutter]\`'s own ~2-4ch column, so \`justify-content: center\`
	 * above centers on the visible pane. \`margin-right: -100cqw\` cancels
	 * that same width's contribution back out of \`[data-gutter]\`'s own
	 * \`minmax(min-content, max-content)\` track — without it, verified live
	 * that \`[data-gutter]\`'s column inflates to match the row's width,
	 * corrupting the gutter/content split the same way containing
	 * \`[data-code]\` directly did above. No \`position\` override needed:
	 * \`[data-gutter]\`'s own stickiness (see the comment above) already pins
	 * this row's resting position, so it doesn't need one of its own.
	 *
	 * In split layout this rule alone gives *both* columns a same-sized,
	 * same-pane-relative-origin copy for unified/deletions, but the
	 * additions column's own coordinate space starts at the pane's
	 * *midpoint*, not its left edge — its \`[data-gutter]\`'s resting
	 * position (pane-absolute) is already one column-width right of
	 * deletions'. The next rule pulls it back by exactly that width so both
	 * copies start at the same pane-absolute x, which is what makes them
	 * compose instead of duplicate.
	 *
	 * \`background\` here is the horizontal rule "through" the pill (matching
	 * the Linear reference — see the top of this override), not a separate
	 * element: an element's background always paints behind its children,
	 * so it sits behind the wrapper pill for free, with no z-index needed,
	 * and the wrapper's own opaque \`background: var(--secondary)\` (below)
	 * naturally masks the segment directly behind it. Has to override the
	 * base rule's \`background: transparent !important\` above, hence
	 * \`!important\` here too — a higher-specificity selector alone doesn't
	 * beat an \`!important\` declaration. \`var(--border)\` matches the pill's
	 * own border color (\`[data-separator-wrapper]\`, below) rather than
	 * introducing a new token — \`--border\` is a low-opacity value by
	 * design (6%/8% white/black, \`index.css\`) used the same way for every
	 * border in the app, not something scoped up for this rule specifically;
	 * verified live in both themes that the resulting line is genuinely
	 * faint against a plain background, without any adjacent fill to
	 * contrast against the way a normal border gets. Spans this row's own
	 * width (\`100cqw\`, or the composed pane width in split, per the rule
	 * below), so it appears in both diff styles without a separate rule.
	 */
	[data-gutter] [data-separator="line-info-basic"] {
		width: 100cqw;
		margin-right: -100cqw;
		background: linear-gradient(var(--border), var(--border)) center / 100% 1px no-repeat !important;
	}

	/**
	 * \`margin-left: -50cqw\` shifts the additions-side copy left by one
	 * column-width (split is always exactly \`1fr 1fr\`,
	 * \`[data-diff-type="split"][data-overflow="scroll"]
	 * { grid-template-columns: 1fr 1fr }\` in style.js, verified live to
	 * render the two columns exactly equal-width) so its \`100cqw\` box starts
	 * at the same pane-absolute x as the deletions copy, instead of at the
	 * additions column's own left edge (pane-absolute 50%). \`[data-code]\`'s
	 * \`overflow: scroll clip\` then does the actual compositing: this
	 * column only has a viewport onto local-x \`[0, 50cqw]\`, which — after
	 * the shift — corresponds to the *right* half of the shared pill, while
	 * deletions' own (unshifted) copy shows the left half. \`margin-right\`
	 * changes from \`-100cqw\` to \`-50cqw\` to match, since the total margin
	 * still needs to cancel the row's \`100cqw\` content width to keep
	 * \`[data-gutter]\`'s own track from inflating (see the rule above) —
	 * \`-50cqw\` left plus \`-50cqw\` right sums to the same \`-100cqw\` the
	 * unshifted rule uses alone. Verified with screenshots, not just
	 * measured rects, that the two halves line up without a visible seam.
	 */
	[data-additions] [data-gutter] [data-separator="line-info-basic"] {
		margin-left: -50cqw;
		margin-right: -50cqw;
	}

	/**
	 * Neutralizes @pierre/diffs' own split-column divider — confirmed live
	 * by temporarily painting it red (\`bun dev --browser\`, a real split
	 * diff) that the vertical line bisecting the composed pill was exactly
	 * \`[data-diff-type="split"][data-overflow="scroll"] { & [data-deletions]
	 * { border-right: 1px solid var(--diffs-bg) } & [data-additions] {
	 * border-left: 1px solid var(--diffs-bg) } }\` in style.js — not a grid
	 * gap (that rule's \`grid-template-columns: 1fr 1fr\` has no \`gap\`,
	 * verified live too: the two columns sit edge-to-edge). Removing the
	 * *color* only (not \`border-right\`/\`-left\` themselves, which would
	 * change \`border-width\` to \`medium\` and reflow the split grid by a
	 * couple of px) is enough, and is safe everywhere, not just this row:
	 * the border's color is \`var(--diffs-bg)\`, the same background color
	 * every row already sits on, so it was already a no-op in every other
	 * row before this override — confirmed live that neutralizing it
	 * changes nothing outside the separator. It only ever showed up here
	 * because the separator row's own \`background: transparent\` (above)
	 * removes the one thing that happened to be masking it elsewhere.
	 *
	 * This divider could *not* have been fixed by raising the pill's own
	 * z-index instead: each column's composed pill-half is hard-clipped by
	 * its own \`[data-code] { overflow: scroll clip }\` at this exact same x
	 * position (see the "FOUR separator elements" comment above), so
	 * neither half's content ever geometrically reaches the seam to paint
	 * over it — z-index only orders paint among things that already
	 * overlap. \`!important\` because @pierre/diffs never uses it in its own
	 * stylesheet (verified against its shipped style.js, same reasoning as
	 * the base rule's \`!important\`s above), so this doesn't need to chase
	 * its selector's specificity or trust shadow-root injection order.
	 */
	[data-deletions] {
		border-right-color: transparent !important;
	}

	[data-additions] {
		border-left-color: transparent !important;
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
