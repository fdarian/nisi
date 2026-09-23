"use client";

import { useEffect } from "react";

/**
 * Cmd+T opens the "open pull request" palette from anywhere in the app —
 * same shortcut a browser uses for "new tab", the closest analogue to what
 * this palette does. Confirmed against Tauri's default macOS menu and this
 * app's own override of it (see use-tab-shortcuts.ts's doc comment for why
 * Cmd+W needs a real menu item instead) — neither claims Cmd+T, so AppKit
 * never intercepts the chord before the webview sees it.
 */
export function useOpenPrPaletteShortcut(onOpen: () => void): void {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "t") return;
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
				return;
			event.preventDefault();
			onOpen();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onOpen]);
}
