"use client";

import { useEffect } from "react";
import { hasNative, native } from "#/infra/native";

/**
 * Closes the About window (`electron/about-window.ts`) on Escape. Nothing
 * else in this single-page window claims that key, unlike ⌘W/⌘⇧W which are
 * real menu accelerators AppKit intercepts before the page ever sees them
 * (see `use-tab-shortcuts.ts`).
 *
 * Showing the window is the main process's job, not this hook's: a
 * frontend-driven show raced the menu handler's "already exists" branch and
 * lost half the time.
 */
export function useAboutWindowChrome(): void {
	useEffect(() => {
		if (!hasNative()) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") native().closeWindow();
		};
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, []);
}
