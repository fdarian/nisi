"use client";

import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { hasNative, native } from "#/infra/native";

/**
 * Opens `/settings` from anywhere in the app. In the desktop app ⌘, is a menu
 * accelerator AppKit handles before the page, so the menu event is the
 * only signal; the keydown listener covers a plain browser.
 */
export function useSettingsShortcut(): void {
	const navigate = useNavigate();

	useEffect(() => {
		const openSettings = () => navigate({ to: "/settings" });

		if (hasNative()) return native().onMenu("open-settings", openSettings);

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
