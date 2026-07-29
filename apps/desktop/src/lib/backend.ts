import { invoke } from "@tauri-apps/api/core";

type BackendInfo = {
	port: number;
	token: string;
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
	return { port: Number(port), token };
}

/** Invoke the Rust get_backend command to get sidecar connection info. Throws on failure. */
async function getBackend(): Promise<BackendInfo> {
	return devBackendOverride() ?? invoke<BackendInfo>("get_backend");
}

export type { BackendInfo };
export { getBackend };
