/**
 * `@pierre/trees` renders into a shadow root, so Tailwind classes never reach
 * it. Three things live here as a result:
 *
 * - Theming happens through the tree's own `--trees-*-override` custom
 *   properties, set as an inline `style` on the light-DOM host. Custom
 *   properties pierce shadow boundaries natively, so this needs no
 *   `unsafeCSS` or post-construction patching.
 * - The category header rows (see `category-tree-paths.ts`) are ordinary
 *   directory rows the tree owns, so making them read as section headers is
 *   pure CSS — static, so it goes in at construction through the tree's own
 *   `unsafeCSS` option rather than being patched in later.
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
import { stripCategory } from "#/components/files-sidebar/category-tree-paths";
import type { ReviewState } from "#/lib/pr-data";

/**
 * Maps our design tokens onto the tree's theme surface. The height is
 * deliberately `100%` of a bounded parent rather than the content's own
 * height: the tree only windows rows while its internal scroller can actually
 * scroll, so sizing the host to fit every row renders every row and makes
 * each scroll frame proportional to the file count.
 */
export function buildTreeThemeStyle(): CSSProperties {
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
		height: "100%",
	} as CSSProperties;
}

const VIEWED_MUTE_STYLE_ATTRIBUTE = "data-nisi-viewed-mute";

function escapeCSSAttributeValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Matches the light-DOM `GroupHeader` flat mode still uses, so the two modes read identically. */
export function buildCategoryRowCSS(
	categoryRowPaths: readonly string[],
): string {
	return categoryRowPaths
		.map((path) => {
			const selector = `[data-item-path="${escapeCSSAttributeValue(path)}"]`;
			return `${selector} > [data-item-section="content"] {
  color: var(--trees-fg-muted);
  font-size: 0.75rem;
  font-weight: 500;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
${selector} > [data-item-section="icon"],
${selector} > [data-item-section="git"] { display: none; }
${selector} > [data-item-section="decoration"] {
  color: var(--trees-fg-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
}`;
		})
		.join("\n");
}

/** CSS text muting the name+icon+git-status-letter of every row in `viewedPaths`. */
export function buildViewedMuteCSS(viewedPaths: ReadonlySet<string>): string {
	return Array.from(viewedPaths, (path) => {
		const selector = `[data-item-path="${escapeCSSAttributeValue(path)}"]`;
		return `${selector} > [data-item-section="content"], ${selector} > [data-item-section="icon"], ${selector} > [data-item-section="git"] { color: var(--trees-fg-muted); }`;
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
 * The decoration lane carries two unrelated things, because it's the only
 * per-row hook the tree exposes: a category header's file count, and a file's
 * "changed after review" dot.
 *
 * `renderRowDecoration` is read once at tree construction — there's no
 * `setRenderRowDecoration`. To stay responsive to either without
 * reconstructing the tree, the callback closes over refs the caller keeps
 * current on every render (mirrors codiff's `lineCountsByPathRef`).
 */
export function createRowDecorationRenderer(
	reviewStateRef: { current: ReadonlyMap<string, ReviewState> },
	categoryRowCountsRef: { current: ReadonlyMap<string, number> },
): FileTreeRowDecorationRenderer {
	return ({ item }) => {
		if (item.kind !== "file") {
			const count = categoryRowCountsRef.current.get(item.path);
			if (count === undefined) return null;
			return { text: String(count), title: `${count} files` };
		}
		if (
			reviewStateRef.current.get(stripCategory(item.path)) !==
			"changed-after-review"
		) {
			return null;
		}
		return {
			text: "changed after review",
			title: "Changed after review",
			parts: [{ text: "●", color: CHANGED_AFTER_REVIEW_DOT_COLOR }],
		};
	};
}
