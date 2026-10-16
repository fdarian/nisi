import { readFile } from "node:fs/promises";

export interface BackendState {
	port: number;
	token: string;
}

const POLL_ATTEMPTS = 16;
const POLL_INTERVAL_MS = 500;
const HEALTH_CHECK_TIMEOUT_MS = 1000;

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `POST /api/health/check`, bearer-authed the same way the frontend and CLI
 * are (see `packages/sidecar-api`'s `makeSidecarClient`). The wire format
 * (`{"json":{}}` in, `{"json":{"status":"ok"}}` out) is oRPC's `RPCHandler`
 * convention, small enough to reproduce here instead of pulling the oRPC client
 * into the main process. A short timeout, since this is always a loopback call.
 */
export async function isBackendAlive(
	port: number,
	token: string,
): Promise<boolean> {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/api/health/check`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ json: {} }),
			signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
		});
		await response.body?.cancel();
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * `sidecar.json` is created by `deskkit/sidecar`'s `acquireSidecar` via one
 * `wx` open-and-write, not a temp-file + rename, so a concurrent reader can
 * briefly see an empty or partial file. A read or parse failure therefore means
 * "not there yet", never a hard error.
 */
async function readSidecarJson(
	path: string,
): Promise<BackendState | undefined> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const port = (parsed as Record<string, unknown>).port;
	const token = (parsed as Record<string, unknown>).token;
	if (
		typeof port !== "number" ||
		!Number.isInteger(port) ||
		port < 0 ||
		port > 65535 ||
		typeof token !== "string"
	) {
		return undefined;
	}
	return { port, token };
}

/**
 * Awaits a `sidecar.json` whose recorded sidecar actually answers, up to ~8 s
 * (16 x 500 ms). The file alone is never trusted: one left behind by a
 * `SIGKILL`'d sidecar would otherwise get cached by `createBackendResolver` for
 * the app's whole lifetime on a port nothing listens on. A dead recorded owner
 * is treated like a missing file, since a fresh sidecar may be about to
 * republish it.
 */
export async function waitForSidecarJson(path: string): Promise<BackendState> {
	for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
		const state = await readSidecarJson(path);
		if (
			state !== undefined &&
			(await isBackendAlive(state.port, state.token))
		) {
			return state;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error(
		`sidecar.json not found (or its sidecar never answered) after 8 s at ${path}`,
	);
}

/**
 * Concurrent callers share one in-flight wait. Only success is cached: a timed
 * out attempt leaves nothing behind, so a later call retries instead of being
 * stuck with a permanently cached error.
 */
export function createBackendResolver(
	sidecarJsonPath: string,
): () => Promise<BackendState> {
	let resolved: BackendState | undefined;
	let inFlight: Promise<BackendState> | undefined;
	return async () => {
		if (resolved !== undefined) {
			return resolved;
		}
		if (inFlight === undefined) {
			inFlight = waitForSidecarJson(sidecarJsonPath)
				.then((state) => {
					resolved = state;
					return state;
				})
				.finally(() => {
					inFlight = undefined;
				});
		}
		return inFlight;
	};
}
