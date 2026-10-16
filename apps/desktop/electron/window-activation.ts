import { app, type BrowserWindow } from "electron";
import { shouldFocusMainWindow } from "./measurement-instance";

/**
 * The measurement instance's window must come up without stealing focus from
 * whatever the measurement harness is driving; everything else raises and
 * activates the app.
 */
export function activateMainWindow(window: BrowserWindow) {
	if (!shouldFocusMainWindow(process.env.NISI_MEASUREMENT_INSTANCE)) {
		if (window.isMinimized()) {
			window.restore();
		}
		window.showInactive();
		return;
	}
	window.show();
	if (window.isMinimized()) {
		window.restore();
	}
	window.focus();
	app.focus({ steal: true });
}
