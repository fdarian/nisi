"use client";

import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/** Emitted by the File menu's "Close Tab" item — see `src-tauri/src/lib.rs`. */
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
	onCloseOtherTabs: (tabId: string) => void;
	/**
	 * Consulted first on ⌘⇧]/⌘⇧[, before tab cycling. Return `true` if
	 * something else (the chat popup) already handled the chord; return
	 * `false`, or omit this prop, to fall through to tab cycling. `"next"` is
	 * ⌘⇧], `"previous"` is ⌘⇧[.
	 */
	onChatThreadShortcut?: (direction: "next" | "previous") => boolean;
};

/**
 * Every tab keybinding in one place, mounted where the tab state lives
 * (`app-shell.tsx`): ⌘⇧] / ⌘⇧[ to step (wrapping), ⌘1…⌘9 to jump, ⌘W to
 * close, and ⌘⌥W to close every tab but the active one. ⌘⇧]/⌘⇧[ aren't
 * unconditionally tab-cycling, though — `onChatThreadShortcut` gets first
 * refusal, so the same chord steps the chat popup's active thread instead
 * whenever the caller says it owns the combo.
 *
 * ⌘W arrives as a *menu* event rather than a keystroke: it's a real File
 * menu item ("Close Tab", distinct from "Close Window" on ⌘⇧W) so it shows up
 * where macOS users look for it, and on macOS a menu key equivalent is
 * consumed before the webview ever sees the key anyway (see
 * `build_macos_menu` in `src-tauri/src/lib.rs`). That also means ⌘W is the
 * one shortcut here with no effect in a plain browser tab — there's no menu to
 * fire it and no window to close. ⌘⌥W has no menu item, so it's a plain
 * `keydown` chord instead — nothing in `build_macos_menu` claims that
 * accelerator, so the webview sees it directly.
 */
export function useTabShortcuts({
	tabIds,
	activeTabId,
	onActivateTab,
	onCloseTab,
	onCloseOtherTabs,
	onChatThreadShortcut,
}: TabShortcutsOptions): void {
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			// Chat's first refusal happens before the text-entry gate below,
			// deliberately: a ⌘⇧-modified bracket is never text input, and the
			// composer (a contenteditable div) holds focus in exactly the state —
			// popup open, thread just switched to — where chat is supposed to own
			// this chord. Gating it the same as everything else would make the
			// whole feature a dead letter outside that one state.
			const bracketDirection = resolveBracketDirection(event);
			if (
				bracketDirection !== undefined &&
				onChatThreadShortcut?.(bracketDirection)
			) {
				event.preventDefault();
				return;
			}

			if (isTextEntry(event.target)) return;

			if (isCloseOtherTabsChord(event)) {
				if (activeTabId === null || tabIds.length <= 1) return;
				event.preventDefault();
				onCloseOtherTabs(activeTabId);
				return;
			}

			const index = resolveTargetIndex(event, tabIds, activeTabId);
			const targetId = index === undefined ? undefined : tabIds[index];
			if (targetId === undefined) return;
			event.preventDefault();
			onActivateTab(targetId);
		};

		const closeActiveTab = () => {
			if (activeTabId === null) return;
			onCloseTab(activeTabId);
		};

		window.addEventListener("keydown", handleKeyDown);
		const unlisten = isTauri()
			? listen(CLOSE_TAB_EVENT, closeActiveTab)
			: undefined;

		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			unlisten?.then((stop) => stop());
		};
	}, [
		tabIds,
		activeTabId,
		onActivateTab,
		onCloseTab,
		onCloseOtherTabs,
		onChatThreadShortcut,
	]);
}

function isCloseOtherTabsChord(event: KeyboardEvent): boolean {
	return (
		event.metaKey &&
		event.altKey &&
		!event.ctrlKey &&
		!event.shiftKey &&
		event.code === "KeyW"
	);
}

/**
 * ⌘⇧]/⌘⇧['s direction, or `undefined` for any other chord — the single
 * place that decodes those two key codes, called both from `handleKeyDown`
 * (to offer the chord to `onChatThreadShortcut` first) and from
 * `resolveTargetIndex` below (to fall back to tab cycling).
 */
function resolveBracketDirection(
	event: KeyboardEvent,
): "next" | "previous" | undefined {
	if (!event.metaKey || event.ctrlKey || event.altKey || !event.shiftKey)
		return undefined;
	if (event.code === "BracketRight") return "next";
	if (event.code === "BracketLeft") return "previous";
	return undefined;
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

	const bracketDirection = resolveBracketDirection(event);
	if (bracketDirection !== undefined) {
		const activeIndex = activeTabId === null ? -1 : tabIds.indexOf(activeTabId);
		if (activeIndex < 0) return undefined;
		const step = bracketDirection === "next" ? 1 : -1;
		// Both wrap, so ⌘⇧] off the right edge lands back on the first tab.
		return (activeIndex + step + tabIds.length) % tabIds.length;
	}
	if (event.shiftKey) return undefined;

	// Chrome and Safari both read ⌘9 as "last tab", not "ninth tab", and make
	// ⌘1…⌘8 no-ops when that many tabs aren't open.
	if (event.code === "Digit9") return tabIds.length - 1;
	const position = POSITION_CODES.indexOf(event.code);
	return position < 0 ? undefined : position;
}

/**
 * Keeps every shortcut here out of the files sidebar's filter box and any
 * other text field, *except* the chat-thread bracket chord — that one is
 * resolved above, before this gate even runs, so it reaches
 * `onChatThreadShortcut` regardless of focus.
 */
function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || TEXT_ENTRY_TAGS.has(target.tagName);
}
