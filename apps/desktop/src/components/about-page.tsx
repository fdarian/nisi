"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { useLayoutEffect } from "react";
import icon from "#/assets/icon.png";
import { Button } from "#/components/ui/button";
import { useAboutWindowChrome } from "#/hooks/use-about-window";

const REPO_URL = "https://github.com/fdarian/nisi";

const MACOS_SYSTEM_FONT =
	'-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/**
 * Content for the About window (`src-tauri/src/lib.rs`'s `build_about_window`)
 * — a separate, fixed-size, native-styled window, not an in-app dialog. The
 * window is created hidden and with a transparent macOS vibrancy background
 * so it reads as a real panel; `useAboutWindowChrome` shows it once this has
 * painted, and `useTransparentBody` (below) is what lets that background
 * actually be visible instead of hidden behind the app's usual opaque one.
 *
 * The macOS system font stack is set here, on this page's own root element,
 * rather than in `index.css` — the app's own display font (Inter) would read
 * as distinctly non-native in a window meant to look like a system panel,
 * but that's a choice specific to this one window, not the whole app.
 */
export function AboutPage(): React.ReactElement {
	useAboutWindowChrome();
	useTransparentBody();

	const shortSha = __APP_COMMIT_SHA__.slice(0, 7);
	const commitUrl = `${REPO_URL}/commit/${__APP_COMMIT_SHA__}`;

	return (
		<div
			className="flex h-screen w-screen flex-col items-center justify-center gap-5 px-10 py-12 text-center"
			style={{ fontFamily: MACOS_SYSTEM_FONT }}
		>
			<img
				alt=""
				className="size-32"
				src={icon}
				style={{ filter: "drop-shadow(0 12px 20px rgba(0, 0, 0, 0.25))" }}
			/>
			<div className="flex flex-col gap-1">
				<h1 className="font-semibold text-2xl leading-tight">nisi</h1>
				<p className="text-muted-foreground text-sm">
					A simpler way to review code.
				</p>
			</div>
			<dl className="grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-sm">
				<dt className="text-right text-muted-foreground">Version</dt>
				<dd className="text-left">{__APP_VERSION__}</dd>
				<dt className="text-right text-muted-foreground">Commit</dt>
				<dd className="text-left">
					<button
						className="font-mono text-info-foreground hover:underline"
						onClick={() => void openUrl(commitUrl)}
						type="button"
					>
						{shortSha}
					</button>
				</dd>
			</dl>
			<div className="flex gap-2">
				<Button
					onClick={() => void openUrl(REPO_URL)}
					size="sm"
					variant="outline"
				>
					GitHub
				</Button>
				<Button
					onClick={() => void openUrl(`${REPO_URL}/issues`)}
					size="sm"
					variant="outline"
				>
					Report an Issue
				</Button>
			</div>
		</div>
	);
}

/**
 * Clears `index.css`'s `body { @apply bg-sidebar ...; }` for the lifetime of
 * this page — the macOS vibrancy material `build_about_window` applies sits
 * behind the webview, and an opaque body would paint over it regardless of
 * that native setup. Scoped to this window's own DOM (a separate
 * webview/JS context from the main window — every Tauri window boots the
 * same `main.tsx` fresh), so it never touches the main window's background.
 */
function useTransparentBody(): void {
	useLayoutEffect(() => {
		const previousBackground = document.body.style.backgroundColor;
		document.body.style.backgroundColor = "transparent";
		return () => {
			document.body.style.backgroundColor = previousBackground;
		};
	}, []);
}
