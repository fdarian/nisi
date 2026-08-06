"use client";

import { useEffect } from "react";

/**
 * Cmd+K opens the app-wide command palette from anywhere — the standard
 * "command palette" chord (VS Code, Linear, Raycast, etc.), distinct from
 * Cmd+T's PR-opener palette (`use-open-pr-palette-shortcut.ts`). Nothing in
 * this app's Tauri menu (`src-tauri/src/lib.rs`) claims Cmd+K, so AppKit
 * never intercepts the chord before the webview sees it.
 */
export function useCommandPaletteShortcut(onOpen: () => void): void {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "k") return;
			if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
				return;
			event.preventDefault();
			onOpen();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onOpen]);
}
