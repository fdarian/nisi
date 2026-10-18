import { Electroview } from "electrobun/view";
import type { MenuEvent, NativeApi } from "../electron/native-api";
import type { NisiRpc } from "./rpc-schema";

/**
 * Loaded as each window's `preload`, which CEF injects as an inline script at
 * the top of `<head>`: it runs before the app bundle, so `window.nisi` is there
 * when `src/main.tsx` boots.
 */

// `views://` has no SPA fallback, so every window loads `index.html` and the
// route it wants rides along as `?nisi-route=`; the router then reads the
// replaced location as if it had been served at that path.
const requestedRoute = new URL(location.href).searchParams.get("nisi-route");
if (requestedRoute === null) {
	throw new Error(`${location.href} carries no nisi-route`);
}
history.replaceState(null, "", requestedRoute);

const menuListeners = new Map<MenuEvent, Set<() => void>>();
const deepLinkListeners = new Set<(url: string) => void>();

const rpc = Electroview.defineRPC<NisiRpc>({
	// getBackend has no deadline on the main-process side while the sidecar boots.
	maxRequestTime: Number.POSITIVE_INFINITY,
	handlers: {
		requests: {},
		messages: {
			menu: (event) => {
				for (const listener of menuListeners.get(event) ?? []) {
					listener();
				}
			},
			deepLink: (url) => {
				for (const listener of deepLinkListeners) {
					listener(url);
				}
			},
		},
	},
});
new Electroview({ rpc });

const api = {
	getBackend: () => rpc.request.getBackend(),
	listAvailableEditors: () => rpc.request.listAvailableEditors(),
	openInEditor: (target) => rpc.request.openInEditor(target),
	pickFolder: (title) => rpc.request.pickFolder({ title }),
	sendNotification: (notification) =>
		rpc.request.sendNotification(notification),
	openUrl: (url) => rpc.request.openUrl({ url }),
	revealInFinder: (path) => rpc.request.revealInFinder({ path }),
	homeDir: () => rpc.request.homeDir(),
	exit: () => rpc.request.exit(),
	closeWindow: () => rpc.send.closeWindow(),
	onMenu: (event, listener) => {
		const listeners = menuListeners.get(event) ?? new Set();
		listeners.add(listener);
		menuListeners.set(event, listeners);
		return () => {
			listeners.delete(listener);
		};
	},
	takePendingDeepLinks: () => rpc.request.takePendingDeepLinks(),
	onDeepLink: (listener) => {
		deepLinkListeners.add(listener);
		return () => {
			deepLinkListeners.delete(listener);
		};
	},
} satisfies NativeApi;

window.nisi = api;
