/**
 * `@repo/settings`-backed preferences — the sidecar is the single source of
 * truth for anything it needs to read back (`enabledHarnesses`, since
 * `walkthrough.harnesses()` reflects it server-side), and the sidebar/diff
 * view modes ride along on the same store rather than `localStorage` since
 * the mechanism costs nothing extra once it exists. Theme stays in
 * `localStorage` via `next-themes` — nothing server-side ever reads it.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { HarnessId } from "#/lib/walkthrough-data";

export type SidebarViewMode = "tree" | "flat";
export type DiffStyleMode = "unified" | "split";

export type Settings = {
	/**
	 * `null` means "never configured" — the walkthrough tab's onboarding gate
	 * fires on exactly this, distinct from `[]` ("configured, chose none").
	 * See `@repo/settings`'s `Settings.enabledHarnesses` doc for the full story.
	 */
	enabledHarnesses: readonly HarnessId[] | null;
	sidebarViewMode: SidebarViewMode;
	diffStyleMode: DiffStyleMode;
	/**
	 * Scheme string of the user's preferred editor (`vscode`/`cursor`/`zed`/
	 * `windsurf` — see `use-available-editors.ts`'s `EditorInfo.id`), or
	 * `null` when never chosen. See `@repo/settings`'s `Settings.preferredEditor`
	 * doc for why this stays a loose `string` rather than a literal union.
	 */
	preferredEditor: string | null;
	/** When true, files already marked reviewed are hidden from the files sidebar and the Files Changed list. */
	hideReviewed: boolean;
	/**
	 * When true, uncommitted working-tree changes should be included alongside
	 * the PR's diff. Sourced by `#/lib/pr-data.ts`'s `useFileChanges`/
	 * `useFileContents` and folded into `diff.files`/`diff.file`'s query
	 * `input` (part of the TanStack Query cache key, not just the request).
	 */
	includeUncommitted: boolean;
	/** Gates the entire walkthrough feature — see `@repo/settings`'s `Settings.walkthroughEnabled`. */
	walkthroughEnabled: boolean;
	/** When true, long diff lines wrap instead of scrolling horizontally. */
	wrapLines: boolean;
	/** Harness id of the last chat model sent with — see `@repo/settings`'s `Settings.lastChatHarness` doc. */
	lastChatHarness: HarnessId | null;
	/** Model id paired with `lastChatHarness` above. */
	lastChatModel: string | null;
};

/**
 * Mirrors `@repo/settings`'s `DEFAULT_SETTINGS` — what `settings.get` resolves
 * to server-side before any `update()` has ever landed. Used here only as the
 * placeholder for the gap between mount and the first response, so a row that
 * genuinely doesn't exist yet still renders the same values the sidecar would
 * return.
 */
const DEFAULT_SETTINGS: Settings = {
	enabledHarnesses: null,
	sidebarViewMode: "tree",
	diffStyleMode: "unified",
	preferredEditor: null,
	hideReviewed: false,
	includeUncommitted: false,
	walkthroughEnabled: false,
	wrapLines: false,
	lastChatHarness: null,
	lastChatModel: null,
};

/** `settings.get`, defaulting to the sidecar's own defaults while the first fetch is in flight. */
export function useSettings(orpc: SidecarQueryUtils): {
	settings: Settings;
	isLoading: boolean;
} {
	const query = useQuery(orpc.settings.get.queryOptions());
	return {
		settings: query.data ?? DEFAULT_SETTINGS,
		isLoading: query.isLoading,
	};
}

/**
 * `settings.update`, writing the mutation's response straight into the
 * `settings.get` cache instead of invalidating — the response *is* the new
 * authoritative row (merged server-side), so there's nothing to refetch.
 *
 * A patch touching `enabledHarnesses` additionally invalidates
 * `walkthrough.harnesses` — its `HarnessInfo.enabled`/`models` are computed
 * server-side off this same setting (see `packages/sidecar-api/src/walkthrough.ts`),
 * so the combobox and the settings page's checkboxes would otherwise show a
 * stale `enabled` flag until something else happened to refetch it.
 */
export function useUpdateSettings(
	orpc: SidecarQueryUtils,
): (patch: Partial<Settings>) => void {
	const queryClient = useQueryClient();
	const mutation = useMutation(orpc.settings.update.mutationOptions());

	return useCallback(
		(patch: Partial<Settings>) => {
			mutation.mutate(patch, {
				onSuccess: (settings) => {
					queryClient.setQueryData(orpc.settings.get.queryKey(), settings);
					if ("enabledHarnesses" in patch) {
						queryClient.invalidateQueries({
							queryKey: orpc.walkthrough.harnesses.key(),
						});
					}
				},
			});
		},
		[mutation, queryClient, orpc],
	);
}

/** Tree/flat display preference for the files sidebar — see `@repo/settings`'s `sidebarViewMode`. */
export function useSidebarViewMode(
	orpc: SidecarQueryUtils,
): [SidebarViewMode, (mode: SidebarViewMode) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setMode = useCallback(
		(mode: SidebarViewMode) => update({ sidebarViewMode: mode }),
		[update],
	);

	return [settings.sidebarViewMode, setMode];
}

/** Split/unified diff display preference — see `@repo/settings`'s `diffStyleMode`. */
export function useDiffStyleMode(
	orpc: SidecarQueryUtils,
): [DiffStyleMode, (mode: DiffStyleMode) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setMode = useCallback(
		(mode: DiffStyleMode) => update({ diffStyleMode: mode }),
		[update],
	);

	return [settings.diffStyleMode, setMode];
}

/** Preferred editor scheme for the "Open in editor" leader shortcut and Settings picker — see `@repo/settings`'s `preferredEditor`. */
export function usePreferredEditor(
	orpc: SidecarQueryUtils,
): [string | null, (preferredEditor: string | null) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setPreferredEditor = useCallback(
		(preferredEditor: string | null) => update({ preferredEditor }),
		[update],
	);

	return [settings.preferredEditor, setPreferredEditor];
}

/** "Hide reviewed" preference for the files sidebar/Files Changed list — see `@repo/settings`'s `hideReviewed`. */
export function useHideReviewed(
	orpc: SidecarQueryUtils,
): [boolean, (hideReviewed: boolean) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setHideReviewed = useCallback(
		(hideReviewed: boolean) => update({ hideReviewed }),
		[update],
	);

	return [settings.hideReviewed, setHideReviewed];
}

/** "Wrap lines" preference for the diff pane — see `@repo/settings`'s `wrapLines`. */
export function useWrapLines(
	orpc: SidecarQueryUtils,
): [boolean, (wrapLines: boolean) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setWrapLines = useCallback(
		(wrapLines: boolean) => update({ wrapLines }),
		[update],
	);

	return [settings.wrapLines, setWrapLines];
}

/** Gates the entire walkthrough feature — see `@repo/settings`'s `walkthroughEnabled`. */
export function useWalkthroughEnabled(
	orpc: SidecarQueryUtils,
): [boolean, (walkthroughEnabled: boolean) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setWalkthroughEnabled = useCallback(
		(walkthroughEnabled: boolean) => update({ walkthroughEnabled }),
		[update],
	);

	return [settings.walkthroughEnabled, setWalkthroughEnabled];
}

/** "Include uncommitted" preference — see `@repo/settings`'s `includeUncommitted`. */
export function useIncludeUncommitted(
	orpc: SidecarQueryUtils,
): [boolean, (includeUncommitted: boolean) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setIncludeUncommitted = useCallback(
		(includeUncommitted: boolean) => update({ includeUncommitted }),
		[update],
	);

	return [settings.includeUncommitted, setIncludeUncommitted];
}

/**
 * Harness/model pair the user last actually sent a chat message with — see
 * `Settings.lastChatHarness`/`lastChatModel`'s doc above. Mirrors
 * `HarnessModelCombobox`'s `ModelSelection` shape, redeclared rather than
 * imported to keep this lib file independent of a component.
 */
export type LastChatModel = { harness: HarnessId; modelId: string | undefined };

/** See `LastChatModel`'s doc above. */
export function useLastChatModel(
	orpc: SidecarQueryUtils,
): [LastChatModel | null, (value: LastChatModel) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const value: LastChatModel | null =
		settings.lastChatHarness === null
			? null
			: {
					harness: settings.lastChatHarness,
					modelId: settings.lastChatModel ?? undefined,
				};

	const setValue = useCallback(
		(next: LastChatModel) =>
			update({
				lastChatHarness: next.harness,
				lastChatModel: next.modelId ?? null,
			}),
		[update],
	);

	return [value, setValue];
}
