import { toastManager } from "#/components/ui/toast";
import { useScheduledMergeEvents } from "#/features/pull-request/data/pr-data";
import { useSettings } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import {
	osNotificationsAvailable,
	sendOsNotification,
} from "#/infra/os-notification";
import { useSidecarEvent } from "#/infra/sidecar-events";
import { useWindowFocused } from "#/infra/use-window-focused";
import { scheduledMergeNotificationChannel } from "./scheduled-merge-notification-channel";

export function ScheduledMergeNotifications(props: {
	orpc: SidecarQueryUtils;
}): null {
	useScheduledMergeEvents(props.orpc);
	const focused = useWindowFocused();
	const query = useSettings(props.orpc);
	useSidecarEvent((event) => {
		if (event.type !== "scheduledMergeSettled") return;
		const pr = `${event.owner}/${event.repo}#${event.number}`;
		const title =
			event.outcome === "merged"
				? "Auto-merge completed"
				: event.outcome === "failed"
					? "Auto-merge failed"
					: "Auto-merge cancelled";
		const body = event.reason ? `${pr}: ${event.reason}` : pr;
		const channel = scheduledMergeNotificationChannel(
			focused,
			query.settings.notificationsEnabled,
			query.settings.notifyScheduledMergeSettled,
		);
		if (channel === "notification" && osNotificationsAvailable()) {
			sendOsNotification({ title, body });
			return;
		}
		toastManager.add({
			title,
			description: body,
			type: event.outcome === "merged" ? "success" : "error",
		});
	});
	return null;
}
