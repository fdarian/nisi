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
	paddingBottom: 12,
	paddingTop: 12,
};

export const diffItemMetrics = {
	diffHeaderHeight: 44,
};

/** Host class toggled per item in `onPostRender` when the file is Reviewed. */
export const DIFF_VIEWED_HOST_CLASS = "nisi-diff-viewed";

export const diffViewUnsafeCSS = `
	:host {
		--diffs-font-family: var(--font-mono);
		--diffs-header-font-family: var(--font-sans);
		--diffs-font-size: 12.5px;
		--diffs-line-height: 20px;
		--diffs-light-bg: var(--code);
		--diffs-dark-bg: var(--code);
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
	 * Hunk-separator pill override — @pierre/diffs has no layout option for
	 * this (checked: hunkSeparators, collapsedContextThreshold,
	 * expansionLineCount, the render* props — none of them touch the
	 * separator's shape, only its content/thresholds). With
	 * \`hunkSeparators: "line-info-basic"\` (see diff-code-view.tsx) it
	 * always renders the "N unchanged lines" control as a 32px band spanning
	 * the full diff width — see createSeparator.js and the
	 * \`[data-separator="line-info-basic"]\` rules in @pierre/diffs'
	 * style.js. The Linear reference this is matching renders that control
	 * as a small centered pill floating between hunks instead, so it's
	 * overridden here against the library's own stable "data-separator" and
	 * "data-expand" attribute hooks (not CSS classes, so this survives minor
	 * version bumps better than most escape hatches would). @pierre/diffs
	 * never uses !important in its own stylesheet
	 * (verified against its shipped style.js), so this block doesn't need
	 * to chase its selector specificity — !important here is deliberate and
	 * contained to this one block. If a @pierre/diffs upgrade changes that
	 * markup, this is the one place to update.
	 */
	[data-separator="line-info-basic"] {
		display: flex;
		align-items: center;
		justify-content: center;
		height: auto !important;
		min-height: 40px;
		background: transparent !important;
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
