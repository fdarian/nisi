/**
 * `@pierre/trees` renders into a shadow root, so Tailwind classes never reach
 * it. Two things live here as a result:
 *
 * - Theming happens through the tree's own `--trees-*-override` custom
 *   properties, set as an inline `style` on the light-DOM host. Custom
 *   properties pierce shadow boundaries natively, so this needs no
 *   `unsafeCSS` or post-construction patching.
 * - "Viewed" muting has no equivalent construction-time option — there's no
 *   per-row class hook, and `renderRowDecoration` only ever paints a separate
 *   decoration lane, not the row's own name/icon. The only way to recolor
 *   those is a `<style>` element appended straight into the shadow root,
 *   scoped by `[data-item-path]`, patched in after the fact and kept in sync
 *   on every render (mirrors codiff's `syncReloadDeltaGitStatusCSS`).
 */
import type { FileTreeRowDecorationRenderer } from "@pierre/trees";
import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import type { CSSProperties } from "react";
import type { ReviewState } from "#/lib/pr-data";

/** Maps our design tokens onto the tree's theme surface. */
export function buildTreeThemeStyle(heightPx: number): CSSProperties {
	return {
		"--trees-fg-override": "var(--sidebar-foreground)",
		"--trees-fg-muted-override": "var(--muted-foreground)",
		"--trees-bg-override": "var(--sidebar)",
		"--trees-bg-muted-override": "var(--sidebar-accent)",
		"--trees-border-color-override": "var(--sidebar-border)",
		"--trees-accent-override": "var(--primary)",
		"--trees-selected-bg-override": "var(--sidebar-accent)",
		"--trees-selected-fg-override": "var(--sidebar-accent-foreground)",
		"--trees-font-family-override": "var(--font-sans)",
		"--trees-focus-ring-color-override": "var(--ring)",
		"--trees-border-radius-override": "var(--radius-md)",
		height: `${heightPx}px`,
	} as CSSProperties;
}

const VIEWED_MUTE_STYLE_ATTRIBUTE = "data-nisi-viewed-mute";

function escapeCSSAttributeValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** CSS text muting the name+icon of every row in `viewedPaths`. */
export function buildViewedMuteCSS(viewedPaths: ReadonlySet<string>): string {
	return Array.from(viewedPaths, (path) => {
		const selector = `[data-item-path="${escapeCSSAttributeValue(path)}"]`;
		return `${selector} > [data-item-section="content"], ${selector} > [data-item-section="icon"] { color: var(--trees-fg-muted); }`;
	}).join("\n");
}

/**
 * Appends/updates the muting `<style>` inside the tree's shadow root.
 * Returns false when the shadow root doesn't exist yet (tree not mounted),
 * so the caller can retry on the next frame.
 */
export function syncViewedMuteStyle(
	treeHost: HTMLElement | null,
	css: string,
): boolean {
	const shadowRoot = treeHost?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
	if (!shadowRoot) return false;

	const existingStyle = shadowRoot.querySelector<HTMLStyleElement>(
		`style[${VIEWED_MUTE_STYLE_ATTRIBUTE}]`,
	);
	if (css.length === 0) {
		existingStyle?.remove();
		return true;
	}

	const style = existingStyle ?? document.createElement("style");
	style.setAttribute(VIEWED_MUTE_STYLE_ATTRIBUTE, "");
	style.textContent = css;
	if (!existingStyle) shadowRoot.append(style);
	return true;
}

const CHANGED_AFTER_REVIEW_DOT_COLOR = "var(--color-orange-500)";

/**
 * `renderRowDecoration` is read once at tree construction — there's no
 * `setRenderRowDecoration`. To stay responsive to review-state changes
 * without reconstructing the tree, the callback closes over a ref that the
 * caller keeps current on every render (mirrors codiff's
 * `lineCountsByPathRef`).
 */
export function createChangedAfterReviewDecorationRenderer(reviewStateRef: {
	current: ReadonlyMap<string, ReviewState>;
}): FileTreeRowDecorationRenderer {
	return ({ item }) => {
		if (item.kind !== "file") return null;
		if (reviewStateRef.current.get(item.path) !== "changed-after-review") {
			return null;
		}
		return {
			text: "changed after review",
			title: "Changed after review",
			parts: [{ text: "●", color: CHANGED_AFTER_REVIEW_DOT_COLOR }],
		};
	};
}
