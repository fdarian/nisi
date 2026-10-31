import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

/**
 * Always transparent: a window's transparency is fixed at creation, and `electron-liquid-glass` has
 * no way to remove its view, so `off` is the renderer painting its frame opaque over a window that
 * is see-through underneath, not a window without glass.
 */
export function glassWindowOptions(): BrowserWindowConstructorOptions {
	return { transparent: true, backgroundColor: "#00000000" };
}

/** Loaded on first use: the addon resolves its native binary at import time, and a failure there must not stop an app whose glass is off from launching. */
function loadLiquidGlass(): typeof import("electron-liquid-glass").default {
	return require("electron-liquid-glass");
}

const windowsWithGlassView = new WeakSet<BrowserWindow>();

/**
 * Turns the window's glass on or off and returns whether glass is now showing. macOS before 26 has
 * no glass, so `enabled` there falls back to a `vibrancy` material; that is why `vibrancy` is never
 * set at window creation (it would override the glass view and look blurry). The view uses the
 * `sidebar` material, which diffuses the wallpaper more than the default `regular`, and is added
 * untinted: it follows the native appearance by itself, and a native `tintColor` would amplify the
 * wallpaper, so any wash is the renderer's.
 */
export function setWindowGlass(
	window: BrowserWindow,
	enabled: boolean,
): boolean {
	if (!enabled) {
		window.setVibrancy(null);
		return false;
	}
	const liquidGlass = loadLiquidGlass();
	if (!liquidGlass.isGlassSupported()) {
		window.setVibrancy("sidebar", { animationDuration: 0 });
		return true;
	}
	if (!windowsWithGlassView.has(window)) {
		const id = liquidGlass.addView(window.getNativeWindowHandle(), {});
		if (id === -1) {
			throw new Error("electron-liquid-glass failed to attach a glass view");
		}
		liquidGlass.unstable_setVariant(
			id,
			liquidGlass.GlassMaterialVariant.sidebar,
		);
		windowsWithGlassView.add(window);
	}
	return true;
}
