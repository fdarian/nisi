import type { NotificationPermission } from "#/infra/os-notification";

export function scheduledMergeNotificationChannel(
	focused: boolean,
	masterEnabled: boolean,
	kindEnabled: boolean,
	permission: NotificationPermission | undefined,
): "notification" | "toast" {
	return !focused && masterEnabled && kindEnabled && permission === "granted"
		? "notification"
		: "toast";
}
