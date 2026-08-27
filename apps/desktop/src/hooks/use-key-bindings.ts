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
 * A `mod+` binding can't also require Shift, by design (see `matchesBinding`)
 * — there's no `"mod+shift+x"` syntax, and a plain `"mod+x"` binding never
 * fires while Shift is held, full stop. A chord that needs Shift (e.g.
 * `use-tab-shortcuts.ts`'s ⌘⇧[/⌘⇧]) has to be its own `keydown` listener
 * outside this hook.
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
		// No current `mod+` binding wants Shift as part of its own chord, so
		// this rejects it outright rather than relying on `event.key` having
		// already been shift-transformed (e.g. "[" -> "{"). That transform
		// isn't something every platform/input path can be trusted to do
		// before this handler sees the event, and a silent miss here would
		// mean a `mod+shift+x` chord owned elsewhere (`use-tab-shortcuts.ts`'s
		// ⌘⇧[/⌘⇧]) could also fire this binding.
		if (event.shiftKey) return false;
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
