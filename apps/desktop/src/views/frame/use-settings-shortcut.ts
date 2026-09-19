"use client";

import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

/** Cmd/Ctrl+, opens `/settings` from anywhere in the app — same shortcut as every native macOS app. */
export function useSettingsShortcut(): void {
	const navigate = useNavigate();

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "," && (event.metaKey || event.ctrlKey)) {
				event.preventDefault();
				navigate({ to: "/settings" });
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [navigate]);
}
