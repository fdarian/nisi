"use client";

import { useEffect } from "react";

/**
 * Cmd/Ctrl+J toggles the quick-chat popup for whatever PR tab is active;
 * Cmd/Ctrl+Shift+J always starts a new thread. Unclaimed by both the
 * frontend and the macOS menu accelerators registered in
 * `src-tauri/src/lib.rs` (only ⌘W/⌘⇧W), so the webview always sees the
 * keydown. Fires regardless of focus, same as `use-settings-shortcut.ts` —
 * this is a real chord, not one of `use-key-bindings.ts`'s bare-key
 * bindings, so it isn't (and shouldn't be) suppressed while the chat
 * composer itself has focus.
 */
export function useChatShortcut(
	onToggle: () => void,
	onNewChat: () => void,
): void {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key.toLowerCase() !== "j") return;
			if (!(event.metaKey || event.ctrlKey)) return;
			event.preventDefault();
			if (event.shiftKey) {
				onNewChat();
				return;
			}
			onToggle();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [onToggle, onNewChat]);
}
