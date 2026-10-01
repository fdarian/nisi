import { isTauri } from "@tauri-apps/api/core";
import { sendNotification } from "@tauri-apps/plugin-notification";

export const osNotificationsAvailable = (): boolean => isTauri();

/** Desktop notification delivery is best effort; the alpha plugin exposes no delivery result. */
export function sendOsNotification(message: {
	title: string;
	body: string;
}): void {
	sendNotification(message);
}
