"use client";

import { useCallback, useState } from "react";

export type DiffStyleMode = "unified" | "split";

const STORAGE_KEY = "nisi:diff-style-mode";

function readStoredDiffStyle(): DiffStyleMode {
	if (typeof window === "undefined") return "unified";
	return window.localStorage.getItem(STORAGE_KEY) === "split"
		? "split"
		: "unified";
}

/** Split/unified diff display preference, persisted across launches — same pattern as `use-sidebar-view-mode`. */
export function useDiffStyleMode(): [
	DiffStyleMode,
	(mode: DiffStyleMode) => void,
] {
	const [mode, setMode] = useState<DiffStyleMode>(readStoredDiffStyle);

	const setPersistedMode = useCallback((next: DiffStyleMode) => {
		setMode(next);
		window.localStorage.setItem(STORAGE_KEY, next);
	}, []);

	return [mode, setPersistedMode];
}
