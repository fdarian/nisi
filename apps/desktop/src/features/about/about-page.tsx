"use client";

import icon from "#/assets/icon.png";
import { native } from "#/infra/native";
import { useAboutWindowChrome } from "./use-about-window";

const REPO_URL = "https://github.com/fdarian/nisi";

const MACOS_SYSTEM_FONT =
	'-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/**
 * A compact AppKit push button (Ghostty's About window reference: small
 * text, tight padding, ~5px corner radius). SwiftUI's `.bordered` style —
 * a translucent overlay *on top of* the window background, not a flat
 * lighter-than-background face with a border. `bg-black/[7%]` in light
 * mode reads as grey sitting on `bg-sidebar`; `bg-white/[12%]` is the same
 * idea inverted for dark. No border — the fill alone has to read as a
 * button, since a lighter-than-background face plus a hairline border
 * (the previous version) put the contrast in the wrong direction and the
 * button all but disappeared into the panel. A plain element, not the
 * shared `Button` component: this exact look belongs to this one window,
 * not the design system.
 */
const APPKIT_BUTTON_CLASSNAME =
	"whitespace-nowrap rounded-[8px] bg-black/[7%] px-2 h-[28px] font-normal text-[13px] text-neutral-900 shadow-[0_0.5px_1px_rgba(0,0,0,0.08)] hover:bg-black/[11%] active:bg-black/[17%] dark:bg-white/[12%] dark:text-neutral-50 dark:shadow-none dark:hover:bg-white/[16%] dark:active:bg-white/[22%]";

/**
 * Content for the About window (`electron/about-window.ts`)
 * — a separate, fixed-size, native-styled window, not an in-app dialog. Shown
 * from the main process once the page finishes loading, not from here (`useAboutWindowChrome`).
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
 * `app-drag` on the root; the commit link and the two buttons are
 * `app-no-drag` so they stay clickable. `select-none` on the root (inherited
 * down) matches a native panel's non-selectable static text and arrow cursor.
 *
 * Bottom-weighted, not centered, matching Ghostty: `pt-[80px]` pins the
 * icon's top edge a fixed distance below the transparent titlebar's traffic
 * lights (which occupy roughly the first 20px), and `pb-[12px]` pins the
 * button row's bottom edge close to the window's. Between those two fixed
 * ends, `justify-between` splits the remaining space evenly across all
 * three inter-section gaps — not `mt-auto` on the button row alone, which
 * piled all the slack into just the gap above it and left the buttons
 * reading as detached from the rest of the column instead of part of it.
 */
export function AboutPage(): React.ReactElement {
	useAboutWindowChrome();

	const shortSha = __APP_COMMIT_SHA__.slice(0, 7);
	const commitUrl = `${REPO_URL}/commit/${__APP_COMMIT_SHA__}`;

	return (
		<div
			className="app-drag flex h-screen w-screen select-none flex-col items-center gap-6 bg-sidebar px-8 pt-[80px] pb-[12px] text-center"
			style={{ fontFamily: MACOS_SYSTEM_FONT }}
		>
			<img
				alt=""
				className="size-28"
				src={icon}
				style={{ filter: "drop-shadow(0 12px 20px rgba(0, 0, 0, 0.25))" }}
			/>
			<div className="flex flex-col gap-1">
				<h1 className="font-semibold text-2xl leading-tight">nisi</h1>
				<p className="text-[11px] text-muted-foreground">
					A simpler way to review code.
				</p>
			</div>
			<dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-[12px]">
				<dt className="text-right">Version</dt>
				<dd className="text-left font-mono">{__APP_VERSION__}</dd>
				<dt className="text-right">Commit</dt>
				<dd className="text-left font-mono">
					<button
						className="app-no-drag cursor-pointer text-info-foreground hover:underline"
						onClick={() => void native().openUrl(commitUrl)}
						type="button"
					>
						{shortSha}
					</button>
				</dd>
			</dl>
			<div className="app-no-drag flex gap-2">
				<button
					className={APPKIT_BUTTON_CLASSNAME}
					onClick={() => void native().openUrl(REPO_URL)}
					type="button"
				>
					GitHub
				</button>
				<button
					className={APPKIT_BUTTON_CLASSNAME}
					onClick={() => void native().openUrl(`${REPO_URL}/issues`)}
					type="button"
				>
					Report an Issue
				</button>
			</div>
		</div>
	);
}
