"use client";

import { useEffect, useRef } from "react";

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export type KeyBindings = Record<string, (event: KeyboardEvent) => void>;

type UseKeyBindingsOptions = {
	/** Mounts/unmounts the listener without the caller needing to conditionally call the hook. Defaults to `true`. */
	enabled?: boolean;
};

/**
 * One window keydown listener for a component's whole set of shortcuts,
 * keyed by a small binding syntax: a bare key (`"j"`, `"1"`, `"Escape"`,
 * matched against `event.key`) or a `"mod+"`-prefixed key (`"mod+f"`) where
 * `mod` means `metaKey` on mac and `ctrlKey` elsewhere.
 *
 * Bare-key bindings are the app's single-letter/digit navigation chords —
 * they're suppressed while typing (an `input`/`textarea`/`select`/
 * `contenteditable` target) and while any modifier is held, so they never
 * steal a character from a text field or collide with a modifier chord.
 * `mod+`-prefixed bindings are real chords: they fire regardless of focus
 * and call `preventDefault()`, the same shape as `use-settings-shortcut.ts`.
 */
export function useKeyBindings(
	bindings: KeyBindings,
	options?: UseKeyBindingsOptions,
): void {
	const enabled = options?.enabled ?? true;

	// Kept in a ref so callers can pass a fresh object/closures each render
	// without the listener churning — only `enabled` re-subscribes it.
	const bindingsRef = useRef(bindings);
	bindingsRef.current = bindings;

	useEffect(() => {
		if (!enabled) return;

		const handleKeyDown = (event: KeyboardEvent) => {
			for (const [binding, handler] of Object.entries(bindingsRef.current)) {
				if (!matchesBinding(binding, event)) continue;
				if (binding.startsWith("mod+")) event.preventDefault();
				handler(event);
				return;
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [enabled]);
}

/** Pure predicate — callers apply side effects like `preventDefault()` themselves once this returns `true`. */
function matchesBinding(binding: string, event: KeyboardEvent): boolean {
	if (binding.startsWith("mod+")) {
		const key = binding.slice("mod+".length);
		if (!isModPressed(event)) return false;
		return event.key.toLowerCase() === key.toLowerCase();
	}

	if (event.key !== binding) return false;
	if (event.metaKey || event.ctrlKey || event.altKey) return false;
	if (isTextEntry(event.target)) return false;
	return true;
}

/** metaKey (⌘) on mac, ctrlKey everywhere else — same split `use-tab-shortcuts.ts` relies on for its own chords. */
function isModPressed(event: KeyboardEvent): boolean {
	const isMac = navigator.platform.toUpperCase().includes("MAC");
	return isMac ? event.metaKey : event.ctrlKey;
}

function isTextEntry(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || TEXT_ENTRY_TAGS.has(target.tagName);
}
