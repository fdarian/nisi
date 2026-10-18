import { Utils } from "electrobun/main";
import { isOpenUrlAllowed } from "../electron/external-url";
import { takePendingDeepLinks } from "./deep-links";
import { listAvailableEditors, openInEditor } from "./editors";
import type { NisiRequestHandlers } from "./rpc-schema";

export function createRequestHandlers(
	getBackend: () => Promise<{ port: number; token: string }>,
): NisiRequestHandlers {
	return {
		getBackend: () => getBackend(),
		listAvailableEditors: () => listAvailableEditors(),
		openInEditor: async (target) => {
			await openInEditor(target);
		},
		// Electrobun's dialog has no title or "create folder" option, and no parent window to sheet onto.
		pickFolder: async () => {
			const picked = await Utils.openFileDialog({
				canChooseFiles: false,
				canChooseDirectory: true,
				allowsMultipleSelection: false,
			});
			if (picked.length === 0) {
				return null;
			}
			const folder = picked[0];
			if (folder === undefined) {
				throw new Error("folder dialog returned no path");
			}
			return folder;
		},
		// No click callback exists, so a clicked notification does not raise the main window.
		sendNotification: (notification) => {
			Utils.showNotification({
				title: notification.title,
				body: notification.body,
			});
		},
		openUrl: (request) => {
			if (!isOpenUrlAllowed(request.url)) {
				throw new Error(`opening ${request.url} is not allowed`);
			}
			if (!Utils.openExternal(request.url)) {
				throw new Error(`failed to open ${request.url}`);
			}
		},
		revealInFinder: (request) => {
			Utils.showItemInFolder(request.path);
		},
		homeDir: () => Utils.paths.home,
		// Quitting runs the `before-quit` hook that kills the sidecar.
		exit: () => {
			if (!Utils.quit(0)) {
				throw new Error("the app is already quitting");
			}
		},
		takePendingDeepLinks: () => takePendingDeepLinks(),
	};
}
