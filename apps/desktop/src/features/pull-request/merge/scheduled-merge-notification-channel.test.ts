import { expect, test } from "bun:test";
import { scheduledMergeNotificationChannel } from "./scheduled-merge-notification-channel";

test("only an unfocused window with both preferences on and permission granted chooses a notification", () => {
	for (const focused of [false, true]) {
		for (const master of [false, true]) {
			for (const kind of [false, true]) {
				for (const permission of [
					"granted",
					"denied",
					"not_determined",
					"unsupported",
					undefined,
				] as const) {
					expect(
						scheduledMergeNotificationChannel(
							focused,
							master,
							kind,
							permission,
						),
					).toBe(
						!focused && master && kind && permission === "granted"
							? "notification"
							: "toast",
					);
				}
			}
		}
	}
});
