"use client";

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/**
 * Closes the About window (`src-tauri/src/lib.rs`'s `build_about_window`)
 * on Escape. Nothing else in this single-page window claims that key,
 * unlike ⌘W/⌘⇧W which are real menu accelerators AppKit intercepts before
 * the webview ever sees them (see `use-tab-shortcuts.ts`).
 *
 * Showing the window is Rust's job now, not this hook's — `build_about_window`
 * shows it from `on_page_load` once the page actually finishes loading. A
 * frontend-driven `show()` here used to race the `on_menu_event` "already
 * exists" branch that also shows/focuses the window, and lost half the
 * time: that's why the first click on "About nisi" used to do nothing.
 */
export function useAboutWindowChrome(): void {
	useEffect(() => {
		if (!isTauri()) return;
		const aboutWindow = getCurrentWindow();

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") void aboutWindow.close();
		};
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, []);
}
