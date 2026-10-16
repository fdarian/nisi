import { BrowserWindow } from "electron";
import {
	guardExternalNavigation,
	rendererOrigin,
	secureWebPreferences,
} from "./renderer-window";

let aboutWindow: BrowserWindow | undefined;

export function isAboutWindow(window: BrowserWindow | null): boolean {
	return window !== null && window === aboutWindow;
}

/**
 * A custom replacement for the native About panel, which can't render the
 * hyperlink to the build commit this app needs (see `src/routes/about.tsx`).
 *
 * Built hidden and shown on `did-finish-load` from here, never from the
 * frontend: a frontend-driven show raced the "already exists" branch below and
 * lost, which made the first click on "About nisi" do nothing.
 */
function createAboutWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 310,
		height: 450,
		useContentSize: true,
		title: "About nisi",
		resizable: false,
		maximizable: false,
		minimizable: false,
		titleBarStyle: "hiddenInset",
		center: true,
		show: false,
		webPreferences: secureWebPreferences,
	});
	guardExternalNavigation(window);
	window.webContents.once("did-finish-load", () => window.show());
	window.once("closed", () => {
		aboutWindow = undefined;
	});
	window.loadURL(`${rendererOrigin()}/about`).catch((e) => {
		console.error(`failed to load the About window: ${e}`);
	});
	return window;
}

export function showAboutWindow() {
	if (aboutWindow !== undefined) {
		aboutWindow.show();
		aboutWindow.focus();
		return;
	}
	aboutWindow = createAboutWindow();
}
