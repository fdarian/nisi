import { join } from "node:path";
import Electrobun, { BuildConfig, Utils } from "electrobun/main";
import { watchActivation } from "../electron/activation";
import { createBackendResolver } from "../electron/backend";
import { resolveDataDirOverride } from "../electron/data-dir";
import { receiveDeepLink } from "./deep-links";
import { installAppMenu } from "./menu";
import { createRequestHandlers } from "./requests";
import { getSidecar, killSidecar, spawnSidecar } from "./sidecar";
import {
	activateMainWindow,
	createMainWindow,
	hasMainWindow,
	requireMainWindow,
	sendToMain,
	showAboutWindow,
} from "./windows";

const dataOverride = resolveDataDirOverride(process.env);
// The macOS default, matching `@repo/db/paths`.
const dataDir =
	dataOverride === null
		? join(Utils.paths.appData, "com.nisi.desktop")
		: dataOverride;

// Registered before anything else: macOS can deliver the URL that launched the app before the window exists.
Electrobun.events.on("open-url", (event) => {
	const url = (event.data as { url: string }).url;
	receiveDeepLink(url, (forwarded) =>
		sendToMain({ name: "deepLink", url: forwarded }),
	);
	// A deep link raises the native window before the frontend resolves its PR; CLI opens arrive over the activation stream instead.
	if (hasMainWindow()) {
		try {
			activateMainWindow(requireMainWindow());
		} catch (e) {
			console.error(`failed to activate the main window for a deep link: ${e}`);
		}
	}
});

Electrobun.events.on("before-quit", killSidecar);
process.on("exit", killSidecar);

try {
	const sidecarJsonPath = join(dataDir, "sidecar.json");
	const requests = createRequestHandlers(
		createBackendResolver(sidecarJsonPath, getSidecar),
	);
	installAppMenu(() => showAboutWindow(requests));
	const ownerId = String(process.pid);
	if (BuildConfig.getSync().isPackaged) {
		spawnSidecar({ dataDir, ownerId });
	}
	createMainWindow(requests);
	void watchActivation({
		sidecarJsonPath,
		ownerId,
		activate: () => activateMainWindow(requireMainWindow()),
	});
} catch (e) {
	console.error(`startup failed: ${e}`);
	killSidecar();
	process.exit(1);
}
