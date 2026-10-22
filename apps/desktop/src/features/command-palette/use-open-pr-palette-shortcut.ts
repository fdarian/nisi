"use client";

import { useEffect } from "react";
import { useAppViewActive } from "#/shell/app-view-context";

/**
 * Cmd+T opens the "open pull request" palette from anywhere in the app —
 * same shortcut a browser uses for "new tab", the closest analogue to what
 * this palette does. Cmd+P opens the same palette already on its repository
 * picker, the chord the palette itself uses for "Filter Project". Confirmed against Electron's default macOS menu and this
 * app's own override of it (see use-tab-shortcuts.ts's doc comment for why
 * Cmd+W needs a real menu item instead) — neither claims Cmd+T, so AppKit
 * never intercepts either chord before the page sees it.
 */
export function useOpenPrPaletteShortcut(
	onOpen: () => void,
	onOpenRepositoryPicker: () => void,
): void {
	const appViewActive = useAppViewActive();
	useEffect(() => {
		if (!appViewActive) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			const key = event.key.toLowerCase();
			if (key !== "t" && key !== "p") return;
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
				return;
			event.preventDefault();
			if (key === "t") onOpen();
			else onOpenRepositoryPicker();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onOpen, onOpenRepositoryPicker, appViewActive]);
}
