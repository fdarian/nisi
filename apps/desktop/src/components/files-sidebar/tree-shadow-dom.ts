/**
 * `@pierre/trees` renders into a shadow root, so Tailwind classes never reach
 * it. Two things live here as a result:
 *
 * - Theming happens through the tree's own `--trees-*-override` custom
 *   properties, set as an inline `style` on the light-DOM host. Custom
 *   properties pierce shadow boundaries natively, so this needs no
 *   `unsafeCSS` or post-construction patching.
 * - "Viewed" muting has no construction-time option — there's no per-row
 *   class hook, and `renderRowDecoration` only ever paints a separate
 *   decoration lane, not the row's own name/icon. The only way to recolor
 *   those is a `<style>` element appended straight into the shadow root,
 *   scoped by `[data-item-path]`, patched in after the fact and kept in sync
 *   on every render (mirrors codiff's `syncReloadDeltaGitStatusCSS`).
 */
import type { FileTreeRowDecorationRenderer } from "@pierre/trees";
import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import type { CSSProperties } from "react";
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
const FOLDER_ICON_STYLE_ATTRIBUTE = "data-nisi-folder-icons";

function escapeCSSAttributeValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** CSS text muting the name+icon+git-status-letter of every row in `viewedPaths`. */
export function buildViewedMuteCSS(viewedPaths: ReadonlySet<string>): string {
	return Array.from(viewedPaths, (path) => {
		const selector = `[data-item-path="${escapeCSSAttributeValue(path)}"]`;
		return `${selector} > [data-item-section="content"], ${selector} > [data-item-section="icon"], ${selector} > [data-item-section="git"] { color: var(--trees-fg-muted); }`;
	}).join("\n");
}

/**
 * Appends/updates a `<style>` inside the tree's shadow root, keyed by
 * `attribute`. Returns false when the shadow root doesn't exist yet (tree
 * not mounted), so the caller can retry on the next frame.
 */
function syncShadowStyle(
	treeHost: HTMLElement | null,
	attribute: string,
	css: string,
): boolean {
	const shadowRoot = treeHost?.querySelector(FILE_TREE_TAG_NAME)?.shadowRoot;
	if (!shadowRoot) return false;

	const existingStyle = shadowRoot.querySelector<HTMLStyleElement>(
		`style[${attribute}]`,
	);
	if (css.length === 0) {
		existingStyle?.remove();
		return true;
	}

	const style = existingStyle ?? document.createElement("style");
	style.setAttribute(attribute, "");
	style.textContent = css;
	if (!existingStyle) shadowRoot.append(style);
	return true;
}

export function syncViewedMuteStyle(
	treeHost: HTMLElement | null,
	css: string,
): boolean {
	return syncShadowStyle(treeHost, VIEWED_MUTE_STYLE_ATTRIBUTE, css);
}

/** A lucide glyph as a `mask-image` URL — the fill comes from `currentcolor`. */
function lucideMaskDataURI(paths: string): string {
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
	return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** lucide `folder` */
const FOLDER_MASK = lucideMaskDataURI(
	'<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
);
/** lucide `folder-open` */
const FOLDER_OPEN_MASK = lucideMaskDataURI(
	'<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
);

const FOLDER_ICON_SLOT =
	'[data-item-type="folder"] > [data-item-section="icon"]';

/**
 * The folder's hinge — lucide's bottom-left corner (2,20 in a 24 viewBox)
 * mapped into the 16px box the tree renders icons at.
 */
const FOLDER_HINGE_ORIGIN = "1.3px 13.3px";
/** Overshoots, so the flap settles rather than stopping dead. */
const FLAP_TRANSITION = "220ms cubic-bezier(0.34, 1.56, 0.64, 1)";
/** Shorter than the flap, so the two glyphs don't linger as a double image. */
const CROSSFADE_TRANSITION = "130ms ease";
/** The rotation each glyph travels through as the folder opens. */
const FLAP_ANGLE = "8deg";

/**
 * Paints folder rows as lucide `folder`/`folder-open`, cross-fading on
 * `aria-expanded`.
 *
 * Two indirections are forced here. The tree's only per-folder icon slot is
 * the disclosure chevron — `resolveIcon("file-tree-icon-chevron")`, resolved
 * once per slot with no notion of expanded state — so the library's `remap`
 * option can't express this and the glyph has to come from CSS. And the swap
 * has to animate, which one element can't do (`mask-image` doesn't
 * interpolate), so both glyphs are painted as pseudo-elements on the slot and
 * cross-faded.
 *
 * The motion follows pqoqubbw/icons: rather than morph `d` (lucide's two
 * folder paths have incompatible command structures), both glyphs rotate the
 * same direction about the folder's hinge while they trade opacity, which
 * reads as one flap swinging open.
 */
function buildFolderIconCSS(): string {
	return `
${FOLDER_ICON_SLOT} {
	position: relative;
}

/* Kept in flow, so the slot keeps its width — only the glyph is replaced. */
${FOLDER_ICON_SLOT} > [data-icon-name="file-tree-icon-chevron"] {
	visibility: hidden;
}

${FOLDER_ICON_SLOT}::before,
${FOLDER_ICON_SLOT}::after {
	content: "";
	position: absolute;
	inset: 0;
	width: 16px;
	height: 16px;
	margin: auto;
	background-color: currentcolor;
	-webkit-mask-repeat: no-repeat;
	mask-repeat: no-repeat;
	-webkit-mask-position: center;
	mask-position: center;
	-webkit-mask-size: 100% 100%;
	mask-size: 100% 100%;
	transform-origin: ${FOLDER_HINGE_ORIGIN};
	transition: opacity ${CROSSFADE_TRANSITION}, transform ${FLAP_TRANSITION};
}

/* Collapsed is the default: closed folder shown, open folder wound back. */
${FOLDER_ICON_SLOT}::before {
	-webkit-mask-image: ${FOLDER_MASK};
	mask-image: ${FOLDER_MASK};
	opacity: 1;
	transform: rotate(0deg);
}
${FOLDER_ICON_SLOT}::after {
	-webkit-mask-image: ${FOLDER_OPEN_MASK};
	mask-image: ${FOLDER_OPEN_MASK};
	opacity: 0;
	transform: rotate(-${FLAP_ANGLE});
}

[aria-expanded="true"]${FOLDER_ICON_SLOT}::before {
	opacity: 0;
	transform: rotate(${FLAP_ANGLE});
}
[aria-expanded="true"]${FOLDER_ICON_SLOT}::after {
	opacity: 1;
	transform: rotate(0deg);
}

@media (prefers-reduced-motion: reduce) {
	${FOLDER_ICON_SLOT}::before,
	${FOLDER_ICON_SLOT}::after {
		transition: none;
		transform: none;
	}
}
`;
}

/**
 * Appends/updates the folder-icon `<style>` inside the tree's shadow root.
 * Returns false when the shadow root doesn't exist yet (tree not mounted),
 * so the caller can retry on the next frame.
 */
export function syncFolderIconStyle(treeHost: HTMLElement | null): boolean {
	return syncShadowStyle(
		treeHost,
		FOLDER_ICON_STYLE_ATTRIBUTE,
		buildFolderIconCSS(),
	);
}

const CHANGED_AFTER_REVIEW_DOT_COLOR = "var(--color-orange-500)";

/**
 * Paints a file's "changed after review" dot into the decoration lane —
 * the only per-row hook the tree exposes.
 *
 * `renderRowDecoration` is read once at tree construction — there's no
 * `setRenderRowDecoration`. To stay responsive without reconstructing the
 * tree, the callback closes over a ref the caller keeps current on every
 * render (mirrors codiff's `lineCountsByPathRef`).
 */
export function createRowDecorationRenderer(reviewStateRef: {
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
