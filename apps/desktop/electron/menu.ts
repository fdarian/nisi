import { BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { isAboutWindow, showAboutWindow } from "./about-window";
import type { MenuEvent } from "./native-api";

export interface MenuActions {
	activateMainWindow: () => void;
	sendToMain: (event: MenuEvent) => void;
}

function report(what: string, run: () => void) {
	try {
		run();
	} catch (e) {
		console.error(`${what}: ${e}`);
	}
}

/**
 * Built from scratch rather than patched from Electron's default menu. A
 * stray default Close/Close Window role would keep its own Cmd+W, and AppKit
 * gives the main menu first refusal on key equivalents before the webview sees
 * them, so File holds two custom items instead:
 * - "Close Tab" (Cmd+W) closes the About window when it's focused; otherwise
 *   the main window's frontend decides (close the active tab, or the window
 *   when it's the last one; see `src/shell/tabs/use-tab-shortcuts.ts`).
 * - "Close Window" (Cmd+Shift+W) closes whichever window is focused.
 */
export function installAppMenu(actions: MenuActions) {
	const template: MenuItemConstructorOptions[] = [
		{
			label: "nisi",
			submenu: [
				// Custom, not the `about` role: the native panel can't render the build commit as a link.
				{ label: "About nisi", click: () => showAboutWindow() },
				{ type: "separator" },
				{
					label: "Settings…",
					accelerator: "CmdOrCtrl+,",
					click: () => {
						// Sent to the main window only: the About window mounts the same root layout and would navigate itself to /settings.
						report("failed to focus the main window for Settings", () =>
							actions.activateMainWindow(),
						);
						report("failed to forward the Settings menu event", () =>
							actions.sendToMain("open-settings"),
						);
					},
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{
					label: "Close Tab",
					accelerator: "CmdOrCtrl+W",
					click: () => {
						const focused = BrowserWindow.getFocusedWindow();
						if (isAboutWindow(focused)) {
							focused?.close();
							return;
						}
						report("failed to forward the Close Tab menu event", () =>
							actions.sendToMain("close-tab"),
						);
					},
				},
				{
					label: "Close Window",
					accelerator: "CmdOrCtrl+Shift+W",
					click: () => {
						const focused = BrowserWindow.getFocusedWindow();
						if (focused === null) {
							console.error(
								"Close Window menu event fired but no window is focused",
							);
							return;
						}
						focused.close();
					},
				},
			],
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{ label: "View", submenu: [{ role: "togglefullscreen" }] },
		{
			label: "Window",
			role: "window",
			submenu: [{ role: "minimize" }, { role: "zoom" }],
		},
		{ label: "Help", role: "help", submenu: [] },
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
