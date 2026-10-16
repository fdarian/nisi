import type { NativeApi } from "../../electron/native-api";

export type { MenuEvent, NativeApi } from "../../electron/native-api";

declare global {
	interface Window {
		/** Injected by the Electron preload; absent in a plain browser tab. */
		nisi?: NativeApi;
	}
}

export function hasNative(): boolean {
	return window.nisi !== undefined;
}

// Read `window.nisi` per call, never at module load: Storybook assigns a stub per story.
export function native(): NativeApi {
	if (window.nisi === undefined) {
		throw new Error("The native bridge (window.nisi) is not available here");
	}
	return window.nisi;
}
