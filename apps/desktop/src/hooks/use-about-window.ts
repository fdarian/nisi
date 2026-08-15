"use client";

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/**
 * Lifecycle glue for the About window (`src-tauri/src/lib.rs`'s
 * `build_about_window`), which is created hidden so it never flashes an
 * unstyled or wrongly-themed first frame:
 *
 * - Shows and focuses the window once this route has actually painted —
 *   two nested `requestAnimationFrame`s, since the first only schedules
 *   *before* the browser commits this render, and only the second is
 *   guaranteed to run after that paint.
 * - Closes the window on Escape. Nothing else in this single-page window
 *   claims that key, unlike ⌘W/⌘⇧W which are real menu accelerators
 *   AppKit intercepts before the webview ever sees them (see
 *   `use-tab-shortcuts.ts`).
 */
export function useAboutWindowChrome(): void {
	useEffect(() => {
		if (!isTauri()) return;
		const aboutWindow = getCurrentWindow();

		let outerFrame = 0;
		let innerFrame = 0;
		outerFrame = requestAnimationFrame(() => {
			innerFrame = requestAnimationFrame(() => {
				void aboutWindow.show();
				void aboutWindow.setFocus();
			});
		});

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") void aboutWindow.close();
		};
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			cancelAnimationFrame(outerFrame);
			cancelAnimationFrame(innerFrame);
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, []);
}
