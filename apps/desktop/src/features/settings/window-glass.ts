import { useSyncExternalStore } from "react";
import { toastManager } from "#/components/ui/toast";
import { hasNative, native } from "#/infra/native";

/** The material behind the main window's frame; `off` paints the frame opaque. */
export const WINDOW_GLASS_KINDS = ["off", "regular", "tinted"] as const;
export type WindowGlass = (typeof WINDOW_GLASS_KINDS)[number];

/** View-only like the theme, so it lives in `localStorage` rather than `@repo/settings`: nothing in the sidecar reads it. */
const STORAGE_KEY = "nisi.windowGlass";

const TINT_STORAGE_KEY = "nisi.windowGlassTint";

/** Percent opacity of the `tinted` wash. */
export const WINDOW_GLASS_TINT_MIN = 20;
export const WINDOW_GLASS_TINT_MAX = 95;
export const WINDOW_GLASS_TINT_STEP = 5;
export const DEFAULT_WINDOW_GLASS_TINT = 70;

const listeners = new Set<() => void>();
const tintListeners = new Set<() => void>();

export const isWindowGlass = (value: string): value is WindowGlass =>
	(WINDOW_GLASS_KINDS as readonly string[]).includes(value);

function readWindowGlass(): WindowGlass {
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === null) {
		return "off";
	}
	if (!isWindowGlass(stored)) {
		// A kind that no longer exists (a build with a `clear` option may have stored it): drop it rather than fail boot.
		localStorage.removeItem(STORAGE_KEY);
		return "off";
	}
	return stored;
}

function readWindowGlassTint(): number {
	const stored = localStorage.getItem(TINT_STORAGE_KEY);
	if (stored === null) {
		return DEFAULT_WINDOW_GLASS_TINT;
	}
	const parsed = Number(stored);
	if (
		!Number.isInteger(parsed) ||
		parsed < WINDOW_GLASS_TINT_MIN ||
		parsed > WINDOW_GLASS_TINT_MAX
	) {
		// Same as an unknown kind: drop it rather than fail boot.
		localStorage.removeItem(TINT_STORAGE_KEY);
		return DEFAULT_WINDOW_GLASS_TINT;
	}
	return parsed;
}

function applyWindowGlassTint(tint: number) {
	document.documentElement.style.setProperty("--glass-tint", `${tint}%`);
}

/** The frame goes transparent only once the main process confirms the glass is behind it. */
async function applyWindowGlass(kind: WindowGlass) {
	if (!hasNative()) {
		return;
	}
	try {
		const showing = await native().setWindowGlass(kind !== "off");
		if (showing) {
			document.documentElement.dataset.nativeGlass = kind;
		} else {
			delete document.documentElement.dataset.nativeGlass;
		}
	} catch (error) {
		toastManager.add({
			type: "error",
			title: "Couldn't apply window glass",
			description: error instanceof Error ? error.message : String(error),
		});
	}
}

/** Call once at boot so a stored choice is in place before the first paint settles. */
export function restoreWindowGlass() {
	// Synchronous, and before the awaited IPC in `applyWindowGlass`: the CSS reads `--glass-tint` with no fallback, so it must exist before `data-native-glass="tinted"` can.
	applyWindowGlassTint(readWindowGlassTint());
	void applyWindowGlass(readWindowGlass());
}

export function setWindowGlass(kind: WindowGlass) {
	localStorage.setItem(STORAGE_KEY, kind);
	for (const listener of listeners) {
		listener();
	}
	void applyWindowGlass(kind);
}

export function useWindowGlass(): WindowGlass {
	return useSyncExternalStore((listener) => {
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
		};
	}, readWindowGlass);
}

export function setWindowGlassTint(tint: number) {
	localStorage.setItem(TINT_STORAGE_KEY, String(tint));
	applyWindowGlassTint(tint);
	for (const listener of tintListeners) {
		listener();
	}
}

export function useWindowGlassTint(): number {
	return useSyncExternalStore((listener) => {
		tintListeners.add(listener);
		return () => {
			tintListeners.delete(listener);
		};
	}, readWindowGlassTint);
}
