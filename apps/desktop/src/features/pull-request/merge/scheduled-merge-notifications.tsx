import { toastManager } from "#/components/ui/toast";
import { useScheduledMergeEvents } from "#/features/pull-request/data/pr-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useSidecarEvent } from "#/infra/sidecar-events";

export function ScheduledMergeNotifications(props: {
	orpc: SidecarQueryUtils;
}): null {
	useScheduledMergeEvents(props.orpc);
	useSidecarEvent((event) => {
		if (event.type !== "scheduledMergeSettled") return;
		const pr = `${event.owner}/${event.repo}#${event.number}`;
		toastManager.add({
			title:
				event.outcome === "merged"
					? `Auto-merged ${pr}`
					: `Auto-merge ${event.outcome} for ${pr}`,
			description: event.reason,
			type: event.outcome === "merged" ? "success" : "error",
		});
	});
	return null;
}
