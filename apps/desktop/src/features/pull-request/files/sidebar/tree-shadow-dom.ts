/**
 * `@pierre/trees` renders into a shadow root, so Tailwind classes never reach
 * it. Theming happens through the tree's own `--trees-*-override` custom
 * properties, set as an inline `style` on the light-DOM host. Custom
 * properties pierce shadow boundaries natively, so this needs no `unsafeCSS`
 * or post-construction patching.
 */
import type { FileTreeRowDecorationRenderer } from "@pierre/trees";
import { FILE_TREE_TAG_NAME } from "@pierre/trees";
import type { CSSProperties } from "react";
import type { FileChange, ReviewStateEntry } from "#/lib/pr-data";

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
		"--trees-bg-override": "var(--pane-surface)",
		"--trees-bg-muted-override": "var(--sidebar-accent)",
		"--trees-border-color-override": "var(--sidebar-border)",
		"--trees-accent-override": "var(--primary)",
		"--trees-selected-bg-override": "var(--sidebar-accent)",
		"--trees-selected-fg-override": "var(--sidebar-accent-foreground)",
		"--trees-font-family-override": "var(--font-sans)",
		"--trees-focus-ring-color-override": "var(--ring)",
		"--trees-border-radius-override": "var(--radius-md)",
		// The lane only reserves row width so a long filename truncates before
		// running under the "…" trigger — the trigger itself is an overlay, not
		// a lane child, so this has to cover its box *and* its inset (see
		// `buildActionButtonCSS`), not just the 16px glyph the default assumes.
		"--trees-action-lane-width-override": "28px",
		height: "100%",
	} as CSSProperties;
}

const FOLDER_ICON_STYLE_ATTRIBUTE = "data-nisi-folder-icons";
const STATUS_COLOR_STYLE_ATTRIBUTE = "data-nisi-status-color";

function escapeCSSAttributeValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
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

const ADDED_FILE_NAME_COLOR = "var(--color-green-500)";
const DELETED_FILE_NAME_COLOR = "var(--color-red-500)";

/** CSS text coloring the filename of every added (green) and deleted (red) row. */
export function buildStatusColorCSS(files: readonly FileChange[]): string {
	return files
		.filter((file) => file.status === "added" || file.status === "deleted")
		.map((file) => {
			const selector = `[data-item-path="${escapeCSSAttributeValue(file.path)}"] > [data-item-section="content"]`;
			const color =
				file.status === "added"
					? ADDED_FILE_NAME_COLOR
					: DELETED_FILE_NAME_COLOR;
			return `${selector} { color: ${color}; }`;
		})
		.join("\n");
}

export function syncStatusColorStyle(
	treeHost: HTMLElement | null,
	css: string,
): boolean {
	return syncShadowStyle(treeHost, STATUS_COLOR_STYLE_ATTRIBUTE, css);
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
/** lucide `check` */
const CHECK_MASK = lucideMaskDataURI('<path d="M20 6 9 17l-5-5"/>');

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

const DECORATION_ICON_STYLE_ATTRIBUTE = "data-nisi-decoration-icons";
const REVIEWED_DECORATION_TITLE = "Reviewed";
const REVIEWED_DECORATION_SLOT = `[data-item-section="decoration"] > span[title="${REVIEWED_DECORATION_TITLE}"]`;

/**
 * Paints the "reviewed" decoration as a masked lucide `check`, the same
 * technique `buildFolderIconCSS` uses — `renderRowDecoration`'s text/icon
 * decoration only ever paints a plain glyph, with no construction-time
 * option for a real icon.
 */
function buildDecorationIconCSS(): string {
	return `
${REVIEWED_DECORATION_SLOT} {
	position: relative;
	display: inline-block;
	width: 14px;
	height: 14px;
}

${REVIEWED_DECORATION_SLOT}::before {
	content: "";
	position: absolute;
	inset: 0;
	background-color: var(--primary);
	-webkit-mask-image: ${CHECK_MASK};
	mask-image: ${CHECK_MASK};
	-webkit-mask-repeat: no-repeat;
	mask-repeat: no-repeat;
	-webkit-mask-position: center;
	mask-position: center;
	-webkit-mask-size: 100% 100%;
	mask-size: 100% 100%;
}
`;
}

/**
 * Appends/updates the decoration-icon `<style>` inside the tree's shadow
 * root. Returns false when the shadow root doesn't exist yet (tree not
 * mounted), so the caller can retry on the next frame.
 */
export function syncDecorationIconStyle(treeHost: HTMLElement | null): boolean {
	return syncShadowStyle(
		treeHost,
		DECORATION_ICON_STYLE_ATTRIBUTE,
		buildDecorationIconCSS(),
	);
}

const ACTION_BUTTON_STYLE_ATTRIBUTE = "data-nisi-action-button";

/** The row-actions "…" button `@pierre/trees` reveals on hover/focus. */
const ACTION_BUTTON_SELECTOR = '[data-type="context-menu-trigger"]';

/**
 * Gives that button `Button`'s `variant="ghost"` icon treatment. The library
 * styles it as a bare glyph — `all: unset` plus a `color`-only hover
 * transition, in a lane exactly as wide as the icon, rounded on its right
 * corners alone — so on hover it only brightened, with no background and
 * nothing to read as a hit target.
 *
 * Overriding works without fighting specificity: the library's own rules are
 * wrapped in `@layer base`, and this injected `<style>` is unlayered, so it
 * wins outright — unlayered CSS always beats layered CSS, whatever the
 * selector weight or document order.
 *
 * `margin-block` is what centers it, and it isn't optional. The button isn't a
 * child of the row: it lives in one shared `context-menu-anchor` overlay that
 * `position: absolute`s to the hovered row's `top` and has no height of its
 * own, so a control shorter than the row hangs from the row's top edge rather
 * than sitting in its middle. The library sidestepped that by sizing the
 * button to the full row height (`row - 2 * ring`, plus a `1px` margin);
 * shrinking it to an inset square means centering it explicitly instead.
 *
 * The background is `--sidebar-accent`, the same token the row hover uses.
 * That reads as a distinct control rather than vanishing into the row it sits
 * on because the token is a 4% *alpha* overlay, not an opaque fill: the
 * button's overlay composites on top of the hovered row's, landing at roughly
 * double the tint.
 */
function buildActionButtonCSS(): string {
	return `
${ACTION_BUTTON_SELECTOR} {
	--nisi-action-button-size: 22px;
	width: var(--nisi-action-button-size);
	height: var(--nisi-action-button-size);
	margin-block: calc((var(--trees-row-height) - var(--nisi-action-button-size)) / 2);
	/* Insets the square from the row's content edge, which is where the
	   overlay's own \`right\` would otherwise flush it against. */
	margin-inline: 0 3px;
	border-radius: var(--radius-md);
	background-color: transparent;
	transition: background-color .12s, color .12s;
}

${ACTION_BUTTON_SELECTOR}:hover,
${ACTION_BUTTON_SELECTOR}[aria-expanded="true"] {
	background-color: var(--sidebar-accent);
	color: var(--sidebar-accent-foreground);
}
`;
}

/**
 * Appends/updates the action-button `<style>` inside the tree's shadow root.
 * Returns false when the shadow root doesn't exist yet (tree not mounted), so
 * the caller can retry on the next frame.
 */
export function syncActionButtonStyle(treeHost: HTMLElement | null): boolean {
	return syncShadowStyle(
		treeHost,
		ACTION_BUTTON_STYLE_ATTRIBUTE,
		buildActionButtonCSS(),
	);
}

const CHANGED_AFTER_REVIEW_DOT_COLOR = "var(--color-orange-500)";

/**
 * Paints a file's review state into the decoration lane — the only per-row
 * hook the tree exposes: an orange dot once it's changed again after review,
 * a checkmark (via `buildDecorationIconCSS`) while it's still viewed.
 *
 * `renderRowDecoration` is read once at tree construction — there's no
 * `setRenderRowDecoration`. To stay responsive without reconstructing the
 * tree, the callback closes over a ref the caller keeps current on every
 * render (mirrors codiff's `lineCountsByPathRef`).
 */
const SCROLL_FADE_STYLE_ATTRIBUTE = "data-nisi-scroll-fade";

/** The tree's internal virtualized scroller — `@pierre/trees`' only `overflow-y: auto` element. */
const SCROLL_CONTAINER_SELECTOR = '[data-file-tree-virtualized-scroll="true"]';

/** Matches `ScrollArea`'s own `scrollFade` fade depth (see scroll-area.tsx). */
const SCROLL_FADE_SIZE = "24px";
const SCROLL_FADE_REVEAL = "96px";

/**
 * Port of shadcn's `scroll-fade` utility (ui.shadcn.com/docs/utils/scroll-fade),
 * hand-copied rather than pulled in as the `shadcn` npm dependency: this repo
 * doesn't install the shadcn CLI as a package (see `apps/desktop/CLAUDE.md`,
 * `@coss` is fetched over `bunx`), and the published utility also injects
 * unrelated utilities (`shimmer`, `no-scrollbar`) this tree doesn't use.
 *
 * `ScrollArea`'s own `scrollFade` prop can't reach here — Base UI's viewport
 * tracks overflow itself, but the tree's scroller lives in a shadow root Base
 * UI never sees — so this re-implements the same mask-image technique scoped
 * to the tree's own scroll container.
 *
 * `@property` is what makes the mask edge glide instead of jumping: without a
 * registered `<length-percentage>` syntax, the browser can't interpolate the
 * custom property across the scroll-linked keyframes. That registration is
 * per-shadow-root, so it has to live in this injected `<style>`, not just in
 * the page's global CSS.
 */
function buildScrollFadeCSS(): string {
	return `
@property --scroll-fade-t {
	syntax: "<length-percentage>";
	inherits: false;
	initial-value: 0px;
}
@property --scroll-fade-b {
	syntax: "<length-percentage>";
	inherits: false;
	initial-value: 0px;
}

@keyframes scroll-fade-reveal-t {
	from { --scroll-fade-t: 0px; }
	to { --scroll-fade-t: ${SCROLL_FADE_SIZE}; }
}
@keyframes scroll-fade-reveal-b {
	from { --scroll-fade-b: ${SCROLL_FADE_SIZE}; }
	to { --scroll-fade-b: 0px; }
}

${SCROLL_CONTAINER_SELECTOR} {
	-webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 var(--scroll-fade-t, 0px), #000 calc(100% - var(--scroll-fade-b, 0px)), transparent 100%);
	mask-image: linear-gradient(to bottom, transparent 0, #000 var(--scroll-fade-t, 0px), #000 calc(100% - var(--scroll-fade-b, 0px)), transparent 100%);
	-webkit-mask-repeat: no-repeat;
	mask-repeat: no-repeat;
}

/* Scroll-driven animation unsupported (pre-26 WebKit): fall back to a static top+bottom fade. */
@supports not (animation-timeline: scroll()) {
	${SCROLL_CONTAINER_SELECTOR} {
		--scroll-fade-t: ${SCROLL_FADE_SIZE};
		--scroll-fade-b: ${SCROLL_FADE_SIZE};
	}
}

@supports (animation-timeline: scroll()) {
	${SCROLL_CONTAINER_SELECTOR} {
		animation: scroll-fade-reveal-t 1ms ease-in-out, scroll-fade-reveal-b 1ms ease-in-out;
		animation-timeline: scroll(self y), scroll(self y);
		animation-range: 0 ${SCROLL_FADE_REVEAL}, calc(100% - ${SCROLL_FADE_REVEAL}) 100%;
		animation-fill-mode: both;
	}
}
`;
}

/**
 * Appends/updates the scroll-fade `<style>` inside the tree's shadow root.
 * Returns false when the shadow root doesn't exist yet (tree not mounted),
 * so the caller can retry on the next frame.
 */
export function syncScrollFadeStyle(treeHost: HTMLElement | null): boolean {
	return syncShadowStyle(
		treeHost,
		SCROLL_FADE_STYLE_ATTRIBUTE,
		buildScrollFadeCSS(),
	);
}

export function createRowDecorationRenderer(reviewStateRef: {
	current: ReadonlyMap<string, ReviewStateEntry>;
}): FileTreeRowDecorationRenderer {
	return ({ item }) => {
		if (item.kind !== "file") return null;
		const state = reviewStateRef.current.get(item.path)?.status;
		if (state === "changed-after-review") {
			return {
				text: "changed after review",
				title: "Changed after review",
				parts: [{ text: "●", color: CHANGED_AFTER_REVIEW_DOT_COLOR }],
			};
		}
		if (state === "viewed") {
			return { text: "", title: REVIEWED_DECORATION_TITLE };
		}
		return null;
	};
}
