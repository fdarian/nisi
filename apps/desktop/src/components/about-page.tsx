"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import icon from "#/assets/icon.png";
import { Button } from "#/components/ui/button";
import { useAboutWindowChrome } from "#/hooks/use-about-window";
import { cn } from "#/lib/utils";

const REPO_URL = "https://github.com/fdarian/nisi";

const MACOS_SYSTEM_FONT =
	'-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/**
 * A compact AppKit push button (Ghostty's About window reference: ~13px
 * text, tight padding, ~6px corner radius, near-white face with a hairline
 * border and a faint shadow — nothing like the app's own `Button` sizes).
 * Local overrides on the shared `Button` rather than a variant on it: this
 * exact look belongs to this one window, not the design system.
 */
const APPKIT_BUTTON_CLASSNAME = cn(
	"h-auto gap-0 rounded-[6px] border-black/15 bg-white px-2.5 py-[3px]",
	"font-normal text-[13px] text-neutral-900 shadow-[0_0.5px_1px_rgba(0,0,0,0.15)]",
	"hover:bg-white active:bg-neutral-100",
	"dark:border-white/15 dark:bg-neutral-600 dark:text-neutral-50 dark:shadow-none",
	"dark:hover:bg-neutral-600 dark:active:bg-neutral-500",
);

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
			className="flex h-screen w-screen select-none flex-col items-center justify-center gap-5 bg-sidebar px-10 py-12 text-center"
			data-tauri-drag-region=""
			style={{ fontFamily: MACOS_SYSTEM_FONT }}
		>
			<img
				alt=""
				className="pointer-events-none size-32"
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
				<Button
					className={APPKIT_BUTTON_CLASSNAME}
					onClick={() => void openUrl(REPO_URL)}
					size="xs"
					variant="outline"
				>
					GitHub
				</Button>
				<Button
					className={APPKIT_BUTTON_CLASSNAME}
					onClick={() => void openUrl(`${REPO_URL}/issues`)}
					size="xs"
					variant="outline"
				>
					Report an Issue
				</Button>
			</div>
		</div>
	);
}
