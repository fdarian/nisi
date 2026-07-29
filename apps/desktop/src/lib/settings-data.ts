/**
 * `@repo/settings`-backed preferences — the sidecar is the single source of
 * truth for anything it needs to read back (`enabledHarnesses`, since
 * `walkthrough.harnesses()` reflects it server-side), and the sidebar/diff
 * view modes ride along on the same store rather than `localStorage` since
 * the mechanism costs nothing extra once it exists. Theme stays in
 * `localStorage` via `next-themes` — nothing server-side ever reads it. See
 * PLAN.md, Phase 4.
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
