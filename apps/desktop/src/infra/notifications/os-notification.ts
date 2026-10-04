import { invoke, isTauri } from "@tauri-apps/api/core";

export type NotificationPermission =
	| "granted"
	| "denied"
	| "not_determined"
	| "unsupported";

export async function notificationPermission(): Promise<NotificationPermission> {
	return isTauri() ? invoke("notification_permission") : "unsupported";
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
	return isTauri() ? invoke("request_notification_permission") : "unsupported";
}

export function sendOsNotification(message: {
	title: string;
	body: string;
}): Promise<void> {
	return invoke("send_notification", message);
}
