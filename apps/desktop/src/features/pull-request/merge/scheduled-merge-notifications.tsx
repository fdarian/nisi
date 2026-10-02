import { toastManager } from "#/components/ui/toast";
import { useScheduledMergeEvents } from "#/features/pull-request/data/pr-data";
import { useSettings } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { sendOsNotification } from "#/infra/os-notification";
import { useSidecarEvent } from "#/infra/sidecar-events";
import { useNotificationPermission } from "#/infra/use-notification-permission";
import { useWindowFocused } from "#/infra/use-window-focused";
import { scheduledMergeNotificationChannel } from "./scheduled-merge-notification-channel";

export function ScheduledMergeNotifications(props: {
	orpc: SidecarQueryUtils;
}): null {
	useScheduledMergeEvents(props.orpc);
	const focused = useWindowFocused();
	const query = useSettings(props.orpc);
	const permission = useNotificationPermission();
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
			permission.data,
		);
		const showToast = () =>
			toastManager.add({
				title,
				description: body,
				type: event.outcome === "merged" ? "success" : "error",
			});
		if (channel === "notification") {
			void sendOsNotification({ title, body }).catch(showToast);
			return;
		}
		showToast();
	});
	return null;
}
