import { invoke } from "@tauri-apps/api/core";

type BackendInfo = {
	port: number;
	token: string;
	/** Only set by the dev harness — see `devBackendOverride`. Rust's `get_backend` omits it, leaving `makeSidecarClient` on its loopback default. */
	host?: string;
};

/**
 * `invoke("get_backend")` only resolves inside the Tauri webview — a plain
 * `vite dev` tab has no IPC bridge and throws immediately, which makes it
 * impossible to open the app in a real browser for visual QA (devtools,
 * screen recording, extensions). When both env vars are set, this points the
 * frontend at an already-running sidecar instead of asking Rust for one.
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

/** Invoke the Rust get_backend command to get sidecar connection info. Throws on failure. */
async function getBackend(): Promise<BackendInfo> {
	return devBackendOverride() ?? invoke<BackendInfo>("get_backend");
}

export type { BackendInfo };
export { getBackend };
