"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";
import type { Session } from "#/features/pull-request/data/pr-data";
import { pullRequestUrl } from "#/features/pull-request/data/pr-data";
import { useKeyBindings } from "#/lib/use-key-bindings";

type OpenInGitHubShortcutOptions = {
	session: Session;
	enabled: boolean;
};

/**
 * Binds the "o g" leader shortcut for the selected PR session, independent of
 * its active sub-tab. Same URL and behavior as the ⌘K palette's "Open Pull
 * Request in GitHub" action (`command-palette.tsx`); a no-op for a branch-only
 * session, which has no PR to open.
 */
export function useOpenInGitHubShortcut(
	options: OpenInGitHubShortcutOptions,
): void {
	const target = options.session.target;
	const openPrInGitHub = useCallback(() => {
		if (target.kind !== "pr") return;
		void openUrl(pullRequestUrl(target));
	}, [target]);

	useKeyBindings({ "o g": openPrInGitHub }, { enabled: options.enabled });
}
