import { frontendBootMark } from "./launch-trace";
import { hasNative, native } from "./native";

type BackendInfo = {
	port: number;
	token: string;
	/** Only set by the dev harness — see `devBackendOverride`. the native `getBackend` omits it, leaving `makeSidecarClient` on its loopback default. */
	host?: string;
	/** Only the web backend sets it: the page was served over https (a tunnel), so the socket must be `wss://`. */
	secure?: boolean;
};

const WEB_TOKEN_KEY = "nisi.web-token";
const WEB_TOKEN_HASH_PREFIX = "#t=";

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

/**
 * The sidecar serves this bundle itself (`sidecar/web-static.ts`), so a plain
 * browser reaches it on the origin it loaded from. The token rides in the
 * link's fragment (`#t=…`) — never sent to a server or logged — and moves into
 * `sessionStorage` so a reload keeps working without the fragment.
 * Call before the router is created: it strips the fragment from the URL.
 */
function captureWebToken(): void {
	if (hasNative()) return;
	const hash = window.location.hash;
	if (!hash.startsWith(WEB_TOKEN_HASH_PREFIX)) return;
	const token = hash.slice(WEB_TOKEN_HASH_PREFIX.length);
	if (token !== "") sessionStorage.setItem(WEB_TOKEN_KEY, token);
	history.replaceState(
		null,
		"",
		window.location.pathname + window.location.search,
	);
}

function webBackend(): BackendInfo {
	const token = sessionStorage.getItem(WEB_TOKEN_KEY);
	if (token === null) {
		throw new Error(
			"No access token. Open the link copied from Settings → Public Access in the nisi app.",
		);
	}
	const secure = window.location.protocol === "https:";
	const port =
		window.location.port === ""
			? secure
				? 443
				: 80
			: Number(window.location.port);
	return { port, token, host: window.location.hostname, secure };
}

/** Sidecar connection info. Throws on failure. */
async function getBackend(): Promise<BackendInfo> {
	const devOverride = devBackendOverride();
	const backend =
		devOverride ?? (hasNative() ? await native().getBackend() : webBackend());
	frontendBootMark("frontend.backend.resolved");
	return backend;
}

export type { BackendInfo };
export { captureWebToken, getBackend };
