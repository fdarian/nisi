import Electrobun, { BrowserView, BrowserWindow, Utils } from "electrobun/main";
import { isHttpUrl } from "../electron/external-url";
import {
	isMeasurementInstance,
	shouldFocusMainWindow,
} from "../electron/measurement-instance";
import type { NisiRequestHandlers, NisiRpc } from "./rpc-schema";

const RENDERER_ORIGIN = "views://mainview";

type WindowRpc = ReturnType<typeof BrowserView.defineRPC<NisiRpc>>;

let main: { window: BrowserWindow; rpc: WindowRpc } | undefined;
let about: BrowserWindow | undefined;
let focused: BrowserWindow | undefined;

export function requireMainWindow(): BrowserWindow {
	if (main === undefined) {
		throw new Error("main window not found");
	}
	return main.window;
}

export function sendToMain(
	message:
		| { name: "menu"; event: "close-tab" | "open-settings" }
		| { name: "deepLink"; url: string },
) {
	if (main === undefined) {
		throw new Error("main window not found");
	}
	if (message.name === "menu") {
		main.rpc.send.menu(message.event);
	} else {
		main.rpc.send.deepLink(message.url);
	}
}

export function hasMainWindow(): boolean {
	return main !== undefined;
}

export function getFocusedWindow(): BrowserWindow | undefined {
	return focused;
}

export function isAboutWindow(window: BrowserWindow | undefined): boolean {
	return window !== undefined && window === about;
}

/**
 * The measurement instance's window must come up without stealing focus from
 * whatever the measurement harness is driving; everything else raises and
 * activates the app.
 */
export function activateMainWindow(window: BrowserWindow) {
	if (!shouldFocusMainWindow(process.env.NISI_MEASUREMENT_INSTANCE)) {
		if (window.isMinimized()) {
			window.unminimize();
		}
		window.showInactive();
		return;
	}
	window.show();
	if (window.isMinimized()) {
		window.unminimize();
	}
	window.activate();
}

function eventDetail(event: unknown): unknown {
	return (event as { data: { detail: unknown } }).data.detail;
}

function openExternalIfHttp(url: string) {
	if (!isHttpUrl(url)) {
		return;
	}
	if (!Utils.openExternal(url)) {
		console.error(`failed to open ${url} externally`);
	}
}

/**
 * The renderer never navigates away or spawns windows: native rules block
 * everything outside `views://mainview/`, and the events those blocks (and
 * popups) raise route http(s) targets to the user's browser instead.
 */
function guardExternalNavigation(window: BrowserWindow) {
	window.webview.setNavigationRules(["^*", `${RENDERER_ORIGIN}/*`]);
	window.webview.on("will-navigate", (event: unknown) => {
		// The native layer reports every navigation, with the verdict of the rules above.
		const navigation = JSON.parse(eventDetail(event) as string) as {
			url: string;
			allowed: boolean;
		};
		if (!navigation.allowed) {
			openExternalIfHttp(navigation.url);
		}
	});
	// Not in `BrowserView.on`'s typed names, but emitted per view like the rest.
	Electrobun.events.on(
		`new-window-open-${window.webview.id}`,
		(event: unknown) => {
			openExternalIfHttp((eventDetail(event) as { url: string }).url);
		},
	);
}

function trackFocus(window: BrowserWindow, onClose: () => void) {
	window.on("focus", () => {
		focused = window;
	});
	window.on("blur", () => {
		if (focused === window) {
			focused = undefined;
		}
	});
	window.on("close", () => {
		if (focused === window) {
			focused = undefined;
		}
		onClose();
	});
}

function windowUrl(route: string): string {
	return `${RENDERER_ORIGIN}/index.html?nisi-route=${encodeURIComponent(route)}`;
}

function createWindowRpc(
	requests: NisiRequestHandlers,
	getWindow: () => BrowserWindow,
): WindowRpc {
	return BrowserView.defineRPC<NisiRpc>({
		maxRequestTime: Number.POSITIVE_INFINITY,
		handlers: {
			requests,
			messages: { closeWindow: () => getWindow().close() },
		},
	});
}

export function createMainWindow(requests: NisiRequestHandlers) {
	const measurement = isMeasurementInstance(process.env);
	let window: BrowserWindow;
	const rpc = createWindowRpc(requests, () => window);
	window = new BrowserWindow({
		title: "Nisi",
		frame: { width: 1100, height: 720 },
		renderer: "cef",
		url: windowUrl("/"),
		preload: "views://bridge/index.js",
		// "hiddenInset", not "hidden": only it keeps the traffic lights, and only it honors the offset (which is relative to their default spot, unlike Electron's absolute `trafficLightPosition`).
		titleBarStyle: "hiddenInset",
		trafficLightOffset: { x: 5, y: 9 },
		hidden: measurement,
		rpc,
	});
	guardExternalNavigation(window);
	trackFocus(window, () => {
		main = undefined;
	});
	if (measurement) {
		// A shown-and-focused window would steal focus from whatever the measurement harness is driving.
		window.webview.on("dom-ready", () => window.showInactive());
	}
	main = { window, rpc };
}

/**
 * A custom replacement for the native About panel, which can't render the
 * hyperlink to the build commit this app needs (see `src/routes/about.tsx`).
 *
 * Built hidden and shown on `dom-ready` from here, never from the frontend: a
 * frontend-driven show raced the "already exists" branch below and lost, which
 * made the first click on "About nisi" do nothing.
 */
export function showAboutWindow(requests: NisiRequestHandlers) {
	if (about !== undefined) {
		about.show();
		about.activate();
		return;
	}
	let window: BrowserWindow;
	const rpc = createWindowRpc(requests, () => window);
	window = new BrowserWindow({
		title: "About nisi",
		frame: { width: 310, height: 450 },
		renderer: "cef",
		url: windowUrl("/about"),
		preload: "views://bridge/index.js",
		titleBarStyle: "hiddenInset",
		styleMask: { Resizable: false, Miniaturizable: false },
		hidden: true,
		rpc,
	});
	about = window;
	guardExternalNavigation(window);
	trackFocus(window, () => {
		about = undefined;
	});
	window.webview.on("dom-ready", () => window.show());
}
