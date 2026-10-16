import { join } from "node:path";
import { app, type BrowserWindow, shell } from "electron";
import { isHttpUrl } from "./external-url";

/** Packaged builds serve `dist/` from `app-protocol.ts`; dev loads the Vite server. */
export function rendererOrigin(): string {
	if (app.isPackaged) {
		return "app://nisi";
	}
	const vitePort = process.env.VITE_PORT;
	if (vitePort === undefined) {
		throw new Error("VITE_PORT is not set; start the app through `bun dev`");
	}
	return `http://localhost:${vitePort}`;
}

export const secureWebPreferences = {
	preload: join(__dirname, "preload.js"),
	contextIsolation: true,
	sandbox: true,
	nodeIntegration: false,
};

function openExternalIfHttp(url: string) {
	if (!isHttpUrl(url)) {
		return;
	}
	shell.openExternal(url).catch((e) => {
		console.error(`failed to open ${url} externally: ${e}`);
	});
}

function isRendererUrl(url: string): boolean {
	const target = URL.parse(url);
	const renderer = new URL(rendererOrigin());
	// Not `URL.origin`: it is the opaque "null" for the non-special `app:` scheme.
	return (
		target !== null &&
		target.protocol === renderer.protocol &&
		target.host === renderer.host
	);
}

/** The renderer never navigates away or spawns windows; http(s) targets go to the user's browser instead. */
export function guardExternalNavigation(window: BrowserWindow) {
	window.webContents.on("will-navigate", (event, url) => {
		if (isRendererUrl(url)) {
			return;
		}
		event.preventDefault();
		openExternalIfHttp(url);
	});
	window.webContents.setWindowOpenHandler((details) => {
		openExternalIfHttp(details.url);
		return { action: "deny" };
	});
}
