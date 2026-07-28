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
`;
