"use client";

import { useCallback } from "react";
import { useKeyBindings } from "#/hooks/use-key-bindings";
import type { NavigationEntry } from "#/lib/navigation-history";
import {
	fileTabPath,
	useSessionNavigationHistory,
} from "#/lib/session-ui-store";

type NavigationShortcutsOptions = {
	sessionId: string;
	enabled: boolean;
	filePaths: ReadonlySet<string>;
	openFiles: readonly string[];
};

/** Binds plain bracket navigation for the selected PR session, independent of its active sub-tab. */
export function useNavigationShortcuts(
	options: NavigationShortcutsOptions,
): void {
	const navigationHistory = useSessionNavigationHistory(options.sessionId);
	const isValidEntry = useCallback(
		(entry: NavigationEntry) => {
			if (
				entry.selectedPath !== null &&
				!options.filePaths.has(entry.selectedPath)
			) {
				return false;
			}
			const filePath = fileTabPath(entry.activeTab);
			return filePath === null || options.openFiles.includes(filePath);
		},
		[options.filePaths, options.openFiles],
	);
	const back = useCallback(() => {
		navigationHistory.back(isValidEntry);
	}, [navigationHistory, isValidEntry]);
	const forward = useCallback(() => {
		navigationHistory.forward(isValidEntry);
	}, [navigationHistory, isValidEntry]);

	useKeyBindings(
		{
			"mod+[": back,
			"mod+]": forward,
		},
		{ enabled: options.enabled },
	);
}
