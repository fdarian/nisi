export function scheduledMergeNotificationChannel(
	focused: boolean,
	masterEnabled: boolean,
	kindEnabled: boolean,
): "notification" | "toast" {
	return !focused && masterEnabled && kindEnabled ? "notification" : "toast";
}
