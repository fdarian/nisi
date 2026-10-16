import { frontendBootMark } from "./launch-trace";
import { native } from "./native";

type BackendInfo = {
	port: number;
	token: string;
	/** Only set by the dev harness — see `devBackendOverride`. the native `getBackend` omits it, leaving `makeSidecarClient` on its loopback default. */
	host?: string;
};

/**
 * `native().getBackend()` only resolves inside the Electron shell — a plain
 * `vite dev` tab has no `window.nisi` bridge and throws immediately, which makes it
 * impossible to open the app in a real browser for visual QA (devtools,
 * screen recording, extensions). When both env vars are set, this points the
 * frontend at an already-running sidecar instead of asking the shell for one.
 * `scripts/dev.ts` sets them in every dev mode, so the Electron window takes
 * this path in dev too.
 * `import.meta.env.DEV` makes the whole branch dead code in a packaged
 * build, so there's no path to it outside `vite dev` regardless of env
 * vars. See apps/desktop/AGENTS.md, "Browser dev harness", for the full
 * recipe.
 */
function devBackendOverride(): BackendInfo | undefined {
	if (!import.meta.env.DEV) return undefined;
	const port = import.meta.env.VITE_DEV_BACKEND_PORT;
	const token = import.meta.env.VITE_DEV_BACKEND_TOKEN;
	if (!port || !token) return undefined;
	// Whatever address this page was loaded from is, by construction, an address
	// the dev machine answers on — vite and the sidecar are the same host. A
	// hardcoded loopback would only be right when the browser is on that machine
	// too; opened from a phone over the LAN (`bun dev --browser --host`), it
	// resolves to the phone itself and every request fails.
	return { port: Number(port), token, host: window.location.hostname };
}

/** Sidecar connection info. Throws on failure. */
async function getBackend(): Promise<BackendInfo> {
	const backend = await (devBackendOverride() ?? native().getBackend());
	frontendBootMark("frontend.backend.resolved");
	return backend;
}

export type { BackendInfo };
export { getBackend };
