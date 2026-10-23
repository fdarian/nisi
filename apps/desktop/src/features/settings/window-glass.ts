import { useSyncExternalStore } from "react";
import { toastManager } from "#/components/ui/toast";
import { hasNative, native } from "#/infra/native";

/** The material behind the main window's frame; `off` paints the frame opaque. */
export const WINDOW_GLASS_KINDS = ["off", "regular", "tinted"] as const;
export type WindowGlass = (typeof WINDOW_GLASS_KINDS)[number];

/** View-only like the theme, so it lives in `localStorage` rather than `@repo/settings`: nothing in the sidecar reads it. */
const STORAGE_KEY = "nisi.windowGlass";

const listeners = new Set<() => void>();

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
