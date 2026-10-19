import { type ChildProcess, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Notification,
	shell,
} from "electron";
import { watchActivation } from "./activation";
import { handleAppProtocol, registerAppScheme } from "./app-protocol";
import { createBackendResolver } from "./backend";
import { resolveDataDirOverride } from "./data-dir";
import { listAvailableEditors, openInEditor } from "./editors";
import { isOpenUrlAllowed } from "./external-url";
import {
	applyMeasurementSwitches,
	verifyMeasurementSwitches,
} from "./measurement";
import { isMeasurementInstance } from "./measurement-instance";
import { installAppMenu } from "./menu";
import type { MenuEvent } from "./native-api";
import {
	guardExternalNavigation,
	rendererOrigin,
	secureWebPreferences,
} from "./renderer-window";
import { activateMainWindow } from "./window-activation";

applyMeasurementSwitches();

const dataOverride = resolveDataDirOverride(process.env);
// The macOS default, matching `@repo/db/paths`.
const dataDir =
	dataOverride === null
		? join(app.getPath("appData"), "com.nisi.desktop")
		: dataOverride;

// Chromium's profile lock is per userData dir; sharing prod's would make a dev instance fail to start while prod runs.
app.setPath("userData", join(dataDir, "electron"));

registerAppScheme();

let mainWindow: BrowserWindow | undefined;
let sidecar: ChildProcess | undefined;
const pendingDeepLinks: string[] = [];
let deepLinksTaken = false;
const liveNotifications = new Set<Notification>();

function requireMainWindow(): BrowserWindow {
	if (mainWindow === undefined || mainWindow.isDestroyed()) {
		throw new Error("main window not found");
	}
	return mainWindow;
}

function sendToMain(
	channel: "nisi:menu" | "nisi:deep-link",
	arg: MenuEvent | string,
) {
	requireMainWindow().webContents.send(channel, arg);
}

function killSidecar() {
	sidecar?.kill();
	sidecar = undefined;
}

// Registered before `ready`: macOS can deliver the URL that launched the app before then.
app.on("open-url", (event, url) => {
	event.preventDefault();
	if (deepLinksTaken && mainWindow !== undefined && !mainWindow.isDestroyed()) {
		sendToMain("nisi:deep-link", url);
	} else {
		pendingDeepLinks.push(url);
	}
	// A deep link raises the native window before the frontend resolves its PR; CLI opens arrive over the activation stream instead.
	if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
		try {
			activateMainWindow(mainWindow);
		} catch (e) {
			console.error(`failed to activate the main window for a deep link: ${e}`);
		}
	}
});

app.on("will-quit", killSidecar);

function spawnSidecar() {
	const child = spawn(
		join(process.resourcesPath, "..", "MacOS", "sidecar"),
		[],
		{
			env: {
				...process.env,
				NISI_DATA_DIR: dataDir,
				NISI_ACTIVATION_OWNER_ID: String(process.pid),
				NISI_WEB_DIR: join(process.resourcesPath, "web"),
			},
			stdio: "ignore",
		},
	);
	child.once("error", (e) => {
		throw new Error(`failed to spawn sidecar: ${e.message}`);
	});
	sidecar = child;
}

function createMainWindow(): BrowserWindow {
	const measurement = isMeasurementInstance(process.env);
	const window = new BrowserWindow({
		width: 1100,
		height: 720,
		useContentSize: true,
		title: "Nisi",
		titleBarStyle: "hidden",
		// Centers the 14px lights in the 44px title strip, over `TrafficLightSpace` in pr-tab-strip.tsx.
		trafficLightPosition: { x: 12, y: 15 },
		show: !measurement,
		webPreferences: secureWebPreferences,
	});
	guardExternalNavigation(window);
	if (measurement) {
		// A shown-and-focused window would steal focus from whatever the measurement harness is driving.
		window.once("ready-to-show", () => window.showInactive());
	}
	window.loadURL(`${rendererOrigin()}/`).catch((e) => {
		console.error(`failed to load the main window: ${e}`);
	});
	return window;
}

function registerIpc(
	getBackend: () => Promise<{ port: number; token: string }>,
) {
	ipcMain.handle("nisi:getBackend", () => getBackend());
	ipcMain.handle("nisi:listAvailableEditors", () => listAvailableEditors());
	ipcMain.handle(
		"nisi:openInEditor",
		(_event, target: Parameters<typeof openInEditor>[0]) =>
			openInEditor(target),
	);
	ipcMain.handle("nisi:pickFolder", async (event, title: string) => {
		const parent = BrowserWindow.fromWebContents(event.sender);
		const options = {
			title,
			properties: ["openDirectory" as const, "createDirectory" as const],
		};
		const result =
			parent === null
				? await dialog.showOpenDialog(options)
				: await dialog.showOpenDialog(parent, options);
		if (result.canceled) {
			return null;
		}
		const picked = result.filePaths[0];
		if (picked === undefined) {
			throw new Error("folder dialog returned no path");
		}
		return picked;
	});
	ipcMain.handle(
		"nisi:sendNotification",
		(_event, notification: { title: string; body: string }) => {
			const native = new Notification({
				title: notification.title,
				body: notification.body,
			});
			liveNotifications.add(native);
			native.once("close", () => liveNotifications.delete(native));
			native.once("click", () => {
				try {
					activateMainWindow(requireMainWindow());
				} catch (e) {
					console.error(
						`failed to focus the main window for a notification: ${e}`,
					);
				}
			});
			native.show();
		},
	);
	ipcMain.handle("nisi:openUrl", async (_event, url: string) => {
		if (!isOpenUrlAllowed(url)) {
			throw new Error(`opening ${url} is not allowed`);
		}
		await shell.openExternal(url);
	});
	ipcMain.handle("nisi:revealInFinder", (_event, path: string) => {
		shell.showItemInFolder(path);
	});
	ipcMain.handle("nisi:homeDir", () => homedir());
	ipcMain.handle("nisi:exit", () => {
		// `app.exit` skips `will-quit`, which is where the sidecar normally dies.
		killSidecar();
		app.exit(0);
	});
	ipcMain.on("nisi:closeWindow", (event) => {
		BrowserWindow.fromWebContents(event.sender)?.close();
	});
	ipcMain.handle("nisi:takePendingDeepLinks", () => {
		deepLinksTaken = true;
		return pendingDeepLinks.splice(0);
	});
}

async function start() {
	verifyMeasurementSwitches(dataDir);
	installAppMenu({
		activateMainWindow: () => activateMainWindow(requireMainWindow()),
		sendToMain: (event) => sendToMain("nisi:menu", event),
	});
	if (app.isPackaged) {
		handleAppProtocol();
	}
	const sidecarJsonPath = join(dataDir, "sidecar.json");
	registerIpc(createBackendResolver(sidecarJsonPath, () => sidecar));
	if (app.isPackaged) {
		spawnSidecar();
	}
	mainWindow = createMainWindow();
	void watchActivation({
		sidecarJsonPath,
		ownerId: app.isPackaged
			? String(process.pid)
			: (process.env.NISI_ACTIVATION_OWNER_ID ?? String(process.pid)),
		activate: () => activateMainWindow(requireMainWindow()),
	});
}

app
	.whenReady()
	.then(start)
	.catch((e) => {
		console.error(`startup failed: ${e}`);
		killSidecar();
		app.exit(1);
	});
