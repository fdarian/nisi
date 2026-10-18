import { ApplicationMenu } from "electrobun/main";
import {
	activateMainWindow,
	getFocusedWindow,
	isAboutWindow,
	requireMainWindow,
	sendToMain,
} from "./windows";

function report(what: string, run: () => void) {
	try {
		run();
	} catch (e) {
		console.error(`${what}: ${e}`);
	}
}

/**
 * Same tree as `electron/menu.ts`, built from scratch for the same reason: a
 * stray default Close role would keep its own Cmd+W, and AppKit gives the main
 * menu first refusal on key equivalents before the webview sees them.
 * - "Close Tab" (Cmd+W) closes the About window when it's focused; otherwise
 *   the main window's frontend decides (close the active tab, or the window
 *   when it's the last one; see `src/shell/tabs/use-tab-shortcuts.ts`).
 * - "Close Window" (Cmd+Shift+W) closes whichever window is focused.
 */
export function installAppMenu(showAbout: () => void) {
	ApplicationMenu.setApplicationMenu([
		{
			label: "nisi",
			submenu: [
				// Custom, not the `about` role: the native panel can't render the build commit as a link.
				{ label: "About nisi", action: "about" },
				{ type: "separator" },
				{
					label: "Settings…",
					action: "open-settings",
					accelerator: "CmdOrCtrl+,",
				},
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "showAll" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: "File",
			submenu: [
				{ label: "Close Tab", action: "close-tab", accelerator: "CmdOrCtrl+W" },
				{
					label: "Close Window",
					action: "close-window",
					accelerator: "CmdOrCtrl+Shift+W",
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
		{ label: "View", submenu: [{ role: "toggleFullScreen" }] },
		{
			label: "Window",
			submenu: [{ role: "minimize" }, { role: "zoom" }],
		},
		{ label: "Help", submenu: [] },
	]);

	ApplicationMenu.on("application-menu-clicked", (event: unknown) => {
		const action = (event as { data: { action: string } }).data.action;
		switch (action) {
			case "about":
				showAbout();
				return;
			case "open-settings":
				// Sent to the main window only: the About window mounts the same root layout and would navigate itself to /settings.
				report("failed to focus the main window for Settings", () =>
					activateMainWindow(requireMainWindow()),
				);
				report("failed to forward the Settings menu event", () =>
					sendToMain({ name: "menu", event: "open-settings" }),
				);
				return;
			case "close-tab": {
				const focused = getFocusedWindow();
				if (isAboutWindow(focused)) {
					focused?.close();
					return;
				}
				report("failed to forward the Close Tab menu event", () =>
					sendToMain({ name: "menu", event: "close-tab" }),
				);
				return;
			}
			case "close-window": {
				const focused = getFocusedWindow();
				if (focused === undefined) {
					console.error(
						"Close Window menu event fired but no window is focused",
					);
					return;
				}
				focused.close();
				return;
			}
			default:
				console.error(`unknown application menu action: ${action}`);
		}
	});
}
