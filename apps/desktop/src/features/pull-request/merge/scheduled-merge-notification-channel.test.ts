import { expect, test } from "bun:test";
import { scheduledMergeNotificationChannel } from "./scheduled-merge-notification-channel";

test("only an unfocused window with both preferences on chooses a notification", () => {
	for (const focused of [false, true]) {
		for (const master of [false, true]) {
			for (const kind of [false, true]) {
				expect(scheduledMergeNotificationChannel(focused, master, kind)).toBe(
					!focused && master && kind ? "notification" : "toast",
				);
			}
		}
	}
});
