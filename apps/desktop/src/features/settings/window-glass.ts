import { useSyncExternalStore } from "react";
import { toastManager } from "#/components/ui/toast";
import { hasNative, native } from "#/infra/native";

/** View-only like the theme, so it lives in `localStorage` rather than `@repo/settings`: nothing in the sidecar reads it. */
const ENABLED_STORAGE_KEY = "nisi.windowGlass";
const TRANSLUCENCY_STORAGE_KEY = "nisi.windowGlassTranslucency";

/** Percent of the layer's fill that lets the glass through. */
export const GLASS_TRANSLUCENCY_MIN = 5;
export const GLASS_TRANSLUCENCY_MAX = 80;
export const GLASS_TRANSLUCENCY_STEP = 5;
export const DEFAULT_GLASS_TRANSLUCENCY = 30;

export const GLASS_THEMES = ["light", "dark"] as const;
export type GlassTheme = (typeof GLASS_THEMES)[number];

/** Which themes a change lands on: `both`, or just the one the user picked. */
export type GlassScope = "both" | GlassTheme;

export type GlassLayer = "frame" | "pane";

/** The two layers' translucency, once the single knob no longer drives them. */
export type GlassLayers = Record<GlassLayer, number>;

export type ThemeGlass = {
	translucency: number;
	/** Set once either layer is adjusted by hand; the single knob is ignored while it is. */
	custom: GlassLayers | null;
};

export type GlassTranslucency = Record<GlassTheme, ThemeGlass>;

/** The inner pane has always been more opaque than the frame around it, and dark glass reads too see-through at the light ratio; the offsets keep the single knob from flattening that. */
const PANE_OFFSET: Record<GlassTheme, number> = { light: 15, dark: -5 };

const DEFAULT_TRANSLUCENCY_PER_THEME: ThemeGlass = {
	translucency: DEFAULT_GLASS_TRANSLUCENCY,
	custom: null,
};

const DEFAULT_TRANSLUCENCY: GlassTranslucency = {
	light: DEFAULT_TRANSLUCENCY_PER_THEME,
	dark: DEFAULT_TRANSLUCENCY_PER_THEME,
};

const enabledListeners = new Set<() => void>();
const translucencyListeners = new Set<() => void>();
const showingListeners = new Set<() => void>();

const clampTranslucency = (value: number) =>
	Math.min(GLASS_TRANSLUCENCY_MAX, Math.max(GLASS_TRANSLUCENCY_MIN, value));

export function resolveGlassLayers(
	theme: GlassTheme,
	glass: ThemeGlass,
): GlassLayers {
	if (glass.custom !== null) {
		return glass.custom;
	}
	return {
		frame: glass.translucency,
		pane: clampTranslucency(glass.translucency + PANE_OFFSET[theme]),
	};
}

const isTranslucency = (value: unknown): value is number =>
	typeof value === "number" &&
	Number.isInteger(value) &&
	value >= GLASS_TRANSLUCENCY_MIN &&
	value <= GLASS_TRANSLUCENCY_MAX;

function isGlassLayers(value: unknown): value is GlassLayers {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const layers = value as Record<string, unknown>;
	return isTranslucency(layers.frame) && isTranslucency(layers.pane);
}

function isThemeGlass(value: unknown): value is ThemeGlass {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const glass = value as Record<string, unknown>;
	return (
		isTranslucency(glass.translucency) &&
		(glass.custom === null || isGlassLayers(glass.custom))
	);
}

function parseTranslucency(raw: string): GlassTranslucency | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (!isThemeGlass(record.light) || !isThemeGlass(record.dark)) {
		return undefined;
	}
	return { light: record.light, dark: record.dark };
}

/** `useSyncExternalStore` needs a stable snapshot, so the parsed value is reused until the stored string changes. */
const translucencyCache: { raw: string | null; value: GlassTranslucency } = {
	raw: null,
	value: DEFAULT_TRANSLUCENCY,
};

function readTranslucency(): GlassTranslucency {
	const raw = localStorage.getItem(TRANSLUCENCY_STORAGE_KEY);
	if (raw === translucencyCache.raw) {
		return translucencyCache.value;
	}
	translucencyCache.raw = raw;
	if (raw === null) {
		translucencyCache.value = DEFAULT_TRANSLUCENCY;
		return translucencyCache.value;
	}
	const parsed = parseTranslucency(raw);
	if (parsed === undefined) {
		// Same as any stale stored value: drop it rather than fail boot.
		localStorage.removeItem(TRANSLUCENCY_STORAGE_KEY);
		translucencyCache.raw = null;
		translucencyCache.value = DEFAULT_TRANSLUCENCY;
		return translucencyCache.value;
	}
	translucencyCache.value = parsed;
	return parsed;
}

function readWindowGlassEnabled(): boolean {
	// `regular` and `tinted` are the kinds an earlier build stored; both mean glass is on.
	const stored = localStorage.getItem(ENABLED_STORAGE_KEY);
	return stored !== null && stored !== "off";
}

/** The CSS reads these per theme (`:root` for light, `.dark` for dark), so a theme switch needs no JS. */
function applyTranslucency(translucency: GlassTranslucency) {
	const style = document.documentElement.style;
	for (const theme of GLASS_THEMES) {
		const layers = resolveGlassLayers(theme, translucency[theme]);
		style.setProperty(`--glass-frame-${theme}`, `${100 - layers.frame}%`);
		style.setProperty(`--glass-pane-${theme}`, `${100 - layers.pane}%`);
	}
}

/** The frame goes transparent only once the main process confirms the glass is behind it. */
async function applyWindowGlass(enabled: boolean) {
	if (!hasNative()) {
		return;
	}
	try {
		const showing = await native().setWindowGlass(enabled);
		if (showing) {
			document.documentElement.dataset.nativeGlass = "on";
		} else {
			delete document.documentElement.dataset.nativeGlass;
		}
		for (const listener of showingListeners) {
			listener();
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
	// Synchronous, and before the awaited IPC in `applyWindowGlass`: the CSS reads these variables with no fallback, so they must exist before `data-native-glass` can.
	applyTranslucency(readTranslucency());
	void applyWindowGlass(readWindowGlassEnabled());
}

export function setWindowGlassEnabled(enabled: boolean) {
	localStorage.setItem(ENABLED_STORAGE_KEY, enabled ? "on" : "off");
	for (const listener of enabledListeners) {
		listener();
	}
	void applyWindowGlass(enabled);
}

export function useWindowGlassEnabled(): boolean {
	return useSyncExternalStore((listener) => {
		enabledListeners.add(listener);
		return () => {
			enabledListeners.delete(listener);
		};
	}, readWindowGlassEnabled);
}

function subscribeNativeGlassShowing(listener: () => void) {
	showingListeners.add(listener);
	return () => {
		showingListeners.delete(listener);
	};
}

/** Whether glass is actually behind the frame (`data-native-glass` is set), not just chosen; false without the native shell. */
export function useNativeGlassShowing(): boolean {
	return useSyncExternalStore(
		subscribeNativeGlassShowing,
		() => document.documentElement.dataset.nativeGlass !== undefined,
	);
}

function updateTranslucency(
	scope: GlassScope,
	update: (theme: GlassTheme, glass: ThemeGlass) => ThemeGlass,
) {
	const current = readTranslucency();
	const next: GlassTranslucency = {
		light: scope === "dark" ? current.light : update("light", current.light),
		dark: scope === "light" ? current.dark : update("dark", current.dark),
	};
	localStorage.setItem(TRANSLUCENCY_STORAGE_KEY, JSON.stringify(next));
	applyTranslucency(next);
	for (const listener of translucencyListeners) {
		listener();
	}
}

/** The single knob: both layers follow it. */
export function setGlassTranslucency(scope: GlassScope, translucency: number) {
	updateTranslucency(scope, (_theme, glass) => ({ ...glass, translucency }));
}

/** Adjusting one layer by hand freezes the other at where the knob had put it. */
export function setGlassLayer(
	scope: GlassScope,
	layer: GlassLayer,
	translucency: number,
) {
	updateTranslucency(scope, (theme, glass) => ({
		...glass,
		custom: { ...resolveGlassLayers(theme, glass), [layer]: translucency },
	}));
}

export function resetGlass(scope: GlassScope) {
	updateTranslucency(scope, () => DEFAULT_TRANSLUCENCY_PER_THEME);
}

export const isGlassModified = (glass: ThemeGlass) =>
	glass.custom !== null || glass.translucency !== DEFAULT_GLASS_TRANSLUCENCY;

export function useGlassTranslucency(): GlassTranslucency {
	return useSyncExternalStore((listener) => {
		translucencyListeners.add(listener);
		return () => {
			translucencyListeners.delete(listener);
		};
	}, readTranslucency);
}
