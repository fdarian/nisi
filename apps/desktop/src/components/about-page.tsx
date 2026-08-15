"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import icon from "#/assets/icon.png";
import { useAboutWindowChrome } from "#/hooks/use-about-window";

const REPO_URL = "https://github.com/fdarian/nisi";

const MACOS_SYSTEM_FONT =
	'-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/**
 * A compact AppKit push button (Ghostty's About window reference: small
 * text, tight padding, ~5px corner radius, a soft off-white — not pure
 * white — face with a faint hairline border). A plain element, not the
 * shared `Button` component: this exact look belongs to this one window,
 * not the design system, and layering it over `Button`'s own opinions
 * (size, gap, hover states) meant half the classes here existed only to
 * cancel those out rather than say what this button actually looks like.
 */
const APPKIT_BUTTON_CLASSNAME =
	"cursor-pointer whitespace-nowrap rounded-[5px] border border-black/8 bg-neutral-50 px-2 py-[2px] font-normal text-[11px] text-neutral-900 shadow-[0_0.5px_1px_rgba(0,0,0,0.08)] active:bg-neutral-200/70 dark:border-white/10 dark:bg-neutral-600 dark:text-neutral-50 dark:shadow-none dark:active:bg-neutral-500";

/**
 * Content for the About window (`src-tauri/src/lib.rs`'s `build_about_window`)
 * — a separate, fixed-size, native-styled window, not an in-app dialog. Shown
 * from Rust once the page finishes loading, not from here (`useAboutWindowChrome`).
 *
 * Background is `bg-sidebar` — an opaque theme token that already adapts to
 * light/dark everywhere else in the app (`app-shell.tsx`'s own root uses the
 * same one), not a native macOS vibrancy/blur material: the panel this is
 * modeled on doesn't use one either, and a translucent window can only be
 * checked by actually running the packaged app on macOS.
 *
 * The macOS system font stack is set here, on this page's own root element,
 * rather than in `index.css` — the app's own display font (Inter) would read
 * as distinctly non-native in a window meant to look like a system panel,
 * but that's a choice specific to this one window, not the whole app.
 *
 * The whole panel is draggable by its background, like a real About window —
 * `data-tauri-drag-region` on the root, but Tauri only starts a drag when
 * the mousedown target itself carries that attribute, not an ancestor. The
 * icon, name, tagline, and info-grid labels/version are `pointer-events-none`
 * instead of each carrying the attribute themselves, so a mousedown there
 * falls through to the root and drags the window; `select-none` on the root
 * (inherited down) matches a native panel's non-selectable static text and
 * arrow cursor. The commit link and the two buttons opt back in with
 * `pointer-events-auto` — those still need to be clickable, not draggable.
 */
export function AboutPage(): React.ReactElement {
	useAboutWindowChrome();

	const shortSha = __APP_COMMIT_SHA__.slice(0, 7);
	const commitUrl = `${REPO_URL}/commit/${__APP_COMMIT_SHA__}`;

	return (
		<div
			className="flex h-screen w-screen select-none flex-col items-center justify-center gap-4 bg-sidebar px-8 py-8 text-center"
			data-tauri-drag-region=""
			style={{ fontFamily: MACOS_SYSTEM_FONT }}
		>
			<img
				alt=""
				className="pointer-events-none size-28"
				src={icon}
				style={{ filter: "drop-shadow(0 12px 20px rgba(0, 0, 0, 0.25))" }}
			/>
			<div className="pointer-events-none flex flex-col gap-1">
				<h1 className="font-semibold text-2xl leading-tight">nisi</h1>
				<p className="text-muted-foreground text-sm">
					A simpler way to review code.
				</p>
			</div>
			<dl className="pointer-events-none grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-sm">
				<dt className="text-right text-muted-foreground">Version</dt>
				<dd className="text-left font-mono">{__APP_VERSION__}</dd>
				<dt className="text-right text-muted-foreground">Commit</dt>
				<dd className="text-left font-mono">
					<button
						className="pointer-events-auto cursor-pointer text-info-foreground hover:underline"
						onClick={() => void openUrl(commitUrl)}
						type="button"
					>
						{shortSha}
					</button>
				</dd>
			</dl>
			<div className="flex gap-2">
				<button
					className={APPKIT_BUTTON_CLASSNAME}
					onClick={() => void openUrl(REPO_URL)}
					type="button"
				>
					GitHub
				</button>
				<button
					className={APPKIT_BUTTON_CLASSNAME}
					onClick={() => void openUrl(`${REPO_URL}/issues`)}
					type="button"
				>
					Report an Issue
				</button>
			</div>
		</div>
	);
}
