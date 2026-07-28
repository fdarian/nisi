"use client";

import { useCallback, useState } from "react";

export type SidebarViewMode = "tree" | "flat";

const STORAGE_KEY = "nisi:files-sidebar-view-mode";

function readStoredViewMode(): SidebarViewMode {
	if (typeof window === "undefined") return "tree";
	return window.localStorage.getItem(STORAGE_KEY) === "flat" ? "flat" : "tree";
}

/** Tree/flat display preference for the files sidebar, persisted across launches. */
export function useSidebarViewMode(): [
	SidebarViewMode,
	(mode: SidebarViewMode) => void,
] {
	const [mode, setMode] = useState<SidebarViewMode>(readStoredViewMode);

	const setPersistedMode = useCallback((next: SidebarViewMode) => {
		setMode(next);
		window.localStorage.setItem(STORAGE_KEY, next);
	}, []);

	return [mode, setPersistedMode];
}
