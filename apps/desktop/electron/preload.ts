import { contextBridge, ipcRenderer } from "electron";
import type { MenuEvent, NativeApi } from "./native-api";

const api = {
	getBackend: () => ipcRenderer.invoke("nisi:getBackend"),
	listAvailableEditors: () => ipcRenderer.invoke("nisi:listAvailableEditors"),
	openInEditor: (target) => ipcRenderer.invoke("nisi:openInEditor", target),
	pickFolder: (title) => ipcRenderer.invoke("nisi:pickFolder", title),
	sendNotification: (notification) =>
		ipcRenderer.invoke("nisi:sendNotification", notification),
	openUrl: (url) => ipcRenderer.invoke("nisi:openUrl", url),
	revealInFinder: (path) => ipcRenderer.invoke("nisi:revealInFinder", path),
	homeDir: () => ipcRenderer.invoke("nisi:homeDir"),
	exit: () => ipcRenderer.invoke("nisi:exit"),
	closeWindow: () => ipcRenderer.send("nisi:closeWindow"),
	onMenu: (event, listener) => {
		const handler = (_ipcEvent: unknown, received: MenuEvent) => {
			if (received === event) {
				listener();
			}
		};
		ipcRenderer.on("nisi:menu", handler);
		return () => {
			ipcRenderer.off("nisi:menu", handler);
		};
	},
	takePendingDeepLinks: () => ipcRenderer.invoke("nisi:takePendingDeepLinks"),
	onDeepLink: (listener) => {
		const handler = (_ipcEvent: unknown, url: string) => listener(url);
		ipcRenderer.on("nisi:deep-link", handler);
		return () => {
			ipcRenderer.off("nisi:deep-link", handler);
		};
	},
} satisfies NativeApi;

contextBridge.exposeInMainWorld("nisi", api);
