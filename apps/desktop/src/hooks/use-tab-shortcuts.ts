"use client";

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";

/** Emitted by the Window menu's "Close Tab" item — see `src-tauri/src/lib.rs`. */
const CLOSE_TAB_EVENT = "menu://close-tab";

/** ⌘1…⌘8 in order; ⌘9 is handled separately because it means "last", not "ninth". */
const POSITION_CODES = [
	"Digit1",
	"Digit2",
	"Digit3",
	"Digit4",
	"Digit5",
	"Digit6",
	"Digit7",
	"Digit8",
];

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

type TabShortcutsOptions = {
	/** Tab ids left to right, in the order the strip renders them. */
	tabIds: readonly string[];
	activeTabId: string | null;
	onActivateTab: (tabId: string) => void;
	onCloseTab: (tabId: string) => void;
};

/**
 * Every tab keybinding in one place, mounted where the tab state lives
 * (`app-shell.tsx`): ⌘⇧] / ⌘⇧[ to step (wrapping), ⌘1…⌘9 to jump, and ⌘W to
 * close.
 *
 * ⌘W arrives as a *menu* event rather than a keystroke: it's a real Window
 * menu item so it shows up where macOS users look for it, and on macOS a menu
 * key equivalent is consumed before the webview ever sees the key anyway (see
 * `menu_with_close_tab` in `src-tauri/src/lib.rs`). That also means ⌘W is the
 * one shortcut here with no effect in a plain browser tab — there's no menu to
 * fire it and no window to close.
 */
export function useTabShortcuts({
	tabIds,
	activeTabId,
	onActivateTab,
	onCloseTab,
}: TabShortcutsOptions): void {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (isTextEntry(event.target)) return;
			const index = resolveTargetIndex(event, tabIds, activeTabId);
			const targetId = index === undefined ? undefined : tabIds[index];
			if (targetId === undefined) return;
			event.preventDefault();
			onActivateTab(targetId);
		};

		/** Browser-style: the last tab's close takes the window with it. */
		const closeActiveTab = () => {
			if (tabIds.length > 1 && activeTabId !== null) {
				onCloseTab(activeTabId);
				return;
			}
			getCurrentWindow().close();
		};

		window.addEventListener("keydown", handleKeyDown);
		const unlisten = isTauri()
			? listen(CLOSE_TAB_EVENT, closeActiveTab)
			: undefined;

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			unlisten?.then((stop) => stop());
		};
	}, [tabIds, activeTabId, onActivateTab, onCloseTab]);
}

/**
 * Which tab a chord selects, or `undefined` when it isn't one of ours.
 * Keyed off `event.code` (physical key) rather than `event.key`, since ⌘⇧]
 * reports `key === "}"` and a shifted digit row reports punctuation.
 */
function resolveTargetIndex(
	event: KeyboardEvent,
	tabIds: readonly string[],
	activeTabId: string | null,
): number | undefined {
	if (!event.metaKey || event.ctrlKey || event.altKey) return undefined;

	if (event.shiftKey) {
		const activeIndex = activeTabId === null ? -1 : tabIds.indexOf(activeTabId);
		if (activeIndex < 0) return undefined;
		// Both wrap, so ⌘⇧] off the right edge lands back on the first tab.
		if (event.code === "BracketRight") return (activeIndex + 1) % tabIds.length;
		if (event.code === "BracketLeft")
			return (activeIndex - 1 + tabIds.length) % tabIds.length;
		return undefined;
	}

	// Chrome and Safari both read ⌘9 as "last tab", not "ninth tab", and make
	// ⌘1…⌘8 no-ops when that many tabs aren't open.
	if (event.code === "Digit9") return tabIds.length - 1;
	const position = POSITION_CODES.indexOf(event.code);
	return position < 0 ? undefined : position;
}

/** Keeps these chords out of the files sidebar's filter box and any other text field. */
function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || TEXT_ENTRY_TAGS.has(target.tagName);
}
