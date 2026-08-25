"use client";

import { useEffect, useRef } from "react";

const TEXT_ENTRY_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Neovim's default `timeoutlen` — how long a leader sequence's pending prefix stays armed waiting for its next step before resetting. */
const LEADER_TIMEOUT_MS = 1000;

export type KeyBindings = Record<string, (event: KeyboardEvent) => void>;

type UseKeyBindingsOptions = {
	/** Mounts/unmounts the listener without the caller needing to conditionally call the hook. Defaults to `true`. */
	enabled?: boolean;
};

/**
 * One window keydown listener for a component's whole set of shortcuts,
 * keyed by a small binding syntax: a bare key (`"j"`, `"1"`, `"Escape"`,
 * matched against `event.key`), a `"mod+"`-prefixed key (`"mod+f"`) where
 * `mod` means `metaKey` on mac and `ctrlKey` elsewhere, or a space-separated
 * leader sequence of bare keys (`"o e"`), matched one step per keydown,
 * neovim-style.
 *
 * Bare-key bindings — including every step of a sequence — are the app's
 * single-letter/digit navigation chords: they're suppressed while typing (an
 * `input`/`textarea`/`select`/`contenteditable` target) and while any
 * modifier is held, so they never steal a character from a text field or
 * collide with a modifier chord. `mod+`-prefixed bindings are real chords:
 * they fire regardless of focus and call `preventDefault()`, the same shape
 * as `use-settings-shortcut.ts`.
 *
 * A sequence arms on its first step's keydown and must complete within
 * `LEADER_TIMEOUT_MS` — a keydown that doesn't continue any armed sequence,
 * an `Escape` keydown, or the timeout itself all reset the pending prefix
 * back to empty, so a stale first step never lingers and swallows a later,
 * unrelated keypress.
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

	// The leader sequence steps matched so far (e.g. `["o"]` while both
	// "o e" and "o g" are still reachable) — a ref, not state, since arming
	// or resetting it must never trigger a re-render of the owning component.
	const pendingStepsRef = useRef<string[]>([]);
	const pendingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (!enabled) return;

		const resetPending = () => {
			pendingStepsRef.current = [];
			if (pendingTimeoutRef.current !== null) {
				clearTimeout(pendingTimeoutRef.current);
				pendingTimeoutRef.current = null;
			}
		};

		const armPending = (steps: readonly string[]) => {
			pendingStepsRef.current = [...steps];
			if (pendingTimeoutRef.current !== null) {
				clearTimeout(pendingTimeoutRef.current);
			}
			pendingTimeoutRef.current = setTimeout(resetPending, LEADER_TIMEOUT_MS);
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			// Escape always aborts a pending sequence outright — a binding
			// literally registered as `"Escape"` still gets its normal,
			// unprefixed shot at this same keydown in the loop below.
			if (event.key === "Escape") resetPending();

			const pendingSteps = pendingStepsRef.current;

			for (const [binding, handler] of Object.entries(bindingsRef.current)) {
				const steps = binding.split(" ");
				const step = steps[pendingSteps.length];
				if (step === undefined) continue;
				if (pendingSteps.some((armed, i) => armed !== steps[i])) continue;
				if (!matchesBinding(step, event)) continue;

				const isFinalStep = pendingSteps.length === steps.length - 1;
				if (!isFinalStep) {
					armPending([...pendingSteps, step]);
					return;
				}

				resetPending();
				if (binding.startsWith("mod+")) event.preventDefault();
				handler(event);
				return;
			}

			// Nothing matched at the current step — a sequence in progress
			// didn't continue, so drop it rather than leaving a stale prefix
			// armed to swallow an unrelated later keypress.
			if (pendingSteps.length > 0) resetPending();
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			resetPending();
		};
	}, [enabled]);
}

/** Pure predicate — callers apply side effects like `preventDefault()` themselves once this returns `true`. Matches exactly one binding step (never a full space-separated sequence) against one keydown. */
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
