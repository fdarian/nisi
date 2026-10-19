import type { PublicAccessStatus } from "@repo/sidecar-api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useSidecarEvent } from "#/infra/sidecar-events";
import { useSettings, useUpdateSettings } from "./settings-data";

/** `Settings.publicAccessEnabled` — see `@repo/settings`. */
export function usePublicAccessEnabled(
	orpc: SidecarQueryUtils,
): [boolean, (enabled: boolean) => void] {
	const { settings } = useSettings(orpc);
	const update = useUpdateSettings(orpc);

	const setEnabled = useCallback(
		(publicAccessEnabled: boolean) => update({ publicAccessEnabled }),
		[update],
	);

	return [settings.publicAccessEnabled, setEnabled];
}

/**
 * `publicAccess.status`, never polled: the sidecar sends
 * `public-access-changed` when the tunnel starts, comes up, stops or dies.
 */
export function usePublicAccessStatus(
	orpc: SidecarQueryUtils,
): PublicAccessStatus | undefined {
	const queryClient = useQueryClient();
	useSidecarEvent((event) => {
		if (event.type !== "public-access-changed") return;
		void queryClient.invalidateQueries({
			queryKey: orpc.publicAccess.status.key(),
		});
	});
	return useQuery(orpc.publicAccess.status.queryOptions()).data;
}
