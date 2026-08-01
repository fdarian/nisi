"use client";

import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

/**
 * Live window-focus state. Under Tauri, via `onFocusChanged`, not DOM
 * `focus`/`blur`/`visibilitychange` — this is a native window, and Tauri's
 * event is the accurate signal for it (see `use-tab-shortcuts.ts`'s doc
 * comment for the same reasoning applied to a different native-vs-DOM
 * choice). Seeds from the window's actual current focus state rather than
 * assuming `true`, since a session watch predicate built on top of this
 * (`pr-data.ts`'s `useSessionWatch`) shouldn't briefly claim "focused" for a
 * window that was opened in the background.
 *
 * `getCurrentWindow()` reads `window.__TAURI_INTERNALS__.metadata` — a plain
 * `vite dev` tab (`apps/desktop/AGENTS.md`'s "Browser dev harness") has no
 * such bridge, so calling it throws synchronously and takes the whole
 * component tree down with it. `isTauri()` (`@tauri-apps/api/core`) is the
 * SDK's own guard for this — the same "are we in Tauri?" check
 * `backend.ts`'s `getBackend()` doc comment points at — so a browser tab
 * falls back to DOM `visibilitychange`/`focus`/`blur` instead, which is the
 * closest DOM equivalent available outside a native window.
 */
export function useWindowFocused(): boolean {
	const [focused, setFocused] = useState(() =>
		isTauri() ? false : document.hasFocus(),
	);

	useEffect(() => {
		if (!isTauri()) {
			const updateFromDocument = () => setFocused(document.hasFocus());
			updateFromDocument();
			document.addEventListener("visibilitychange", updateFromDocument);
			window.addEventListener("focus", updateFromDocument);
			window.addEventListener("blur", updateFromDocument);
			return () => {
				document.removeEventListener("visibilitychange", updateFromDocument);
				window.removeEventListener("focus", updateFromDocument);
				window.removeEventListener("blur", updateFromDocument);
			};
		}

		let cancelled = false;
		const tauriWindow = getCurrentWindow();

		tauriWindow.isFocused().then((isFocused) => {
			if (!cancelled) setFocused(isFocused);
		});

		// `onFocusChanged` resolves to an unlisten function asynchronously —
		// an unmount before that promise settles must still unlisten, or the
		// listener outlives the component and keeps calling a stale setState.
		const unlistenPromise = tauriWindow.onFocusChanged(({ payload }) => {
			setFocused(payload);
		});

		return () => {
			cancelled = true;
			unlistenPromise.then((unlisten) => unlisten());
		};
	}, []);

	return focused;
}
