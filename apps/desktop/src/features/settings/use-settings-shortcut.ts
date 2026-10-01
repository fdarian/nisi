"use client";

import { useNavigate } from "@tanstack/react-router";
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";

/** Emitted by the app menu's "Settings…" item — see `src-tauri/src/lib.rs`. */
const OPEN_SETTINGS_EVENT = "menu://open-settings";

/**
 * Opens `/settings` from anywhere in the app. In the desktop app ⌘, is a menu
 * accelerator AppKit handles before the webview, so the menu event is the
 * only signal; the keydown listener covers a plain browser.
 */
export function useSettingsShortcut(): void {
	const navigate = useNavigate();

	useEffect(() => {
		const openSettings = () => navigate({ to: "/settings" });

		if (isTauri()) {
			const unlisten = listen(OPEN_SETTINGS_EVENT, openSettings);
			return () => {
				unlisten.then((stop) => stop());
			};
		}

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "," && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				openSettings();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [navigate]);
}
