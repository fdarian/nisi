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

/** The slice of a `ChildProcess` the wait needs; both codes stay `null` until it exits. */
export type SpawnedSidecar = {
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
};

type PollTiming = { attempts: number; intervalMs: number };

function describeGiveUp(spawned: SpawnedSidecar | undefined): string {
	if (spawned === undefined) {
		return "no sidecar is running";
	}
	if (spawned.signalCode !== null) {
		return `the spawned sidecar was killed by ${spawned.signalCode}`;
	}
	return `the spawned sidecar exited with code ${spawned.exitCode}`;
}

/**
 * Awaits a `sidecar.json` whose recorded sidecar actually answers. The file
 * alone is never trusted: one left behind by a `SIGKILL`'d sidecar would
 * otherwise get cached by `createBackendResolver` for the app's whole lifetime
 * on a port nothing listens on. A dead recorded owner is treated like a missing
 * file, since a fresh sidecar may be about to republish it.
 *
 * `getSpawned` returns the sidecar child this app started, if any. While it is
 * alive the wait has no deadline, because a cold first start can take longer
 * than any fixed budget. Once it has exited (or none was spawned) the wait gives
 * up after ~8 s (16 x 500 ms). A spawned child that exits early because another
 * sidecar already owns the lock is fine: that owner's `sidecar.json` passes the
 * health check.
 */
export async function waitForSidecarJson(
	path: string,
	getSpawned: () => SpawnedSidecar | undefined,
	timing: PollTiming = {
		attempts: POLL_ATTEMPTS,
		intervalMs: POLL_INTERVAL_MS,
	},
): Promise<BackendState> {
	for (let attempt = 1; ; attempt++) {
		const state = await readSidecarJson(path);
		if (
			state !== undefined &&
			(await isBackendAlive(state.port, state.token))
		) {
			return state;
		}
		if (attempt >= timing.attempts) {
			const spawned = getSpawned();
			const running =
				spawned !== undefined &&
				spawned.exitCode === null &&
				spawned.signalCode === null;
			if (!running) {
				throw new Error(
					`sidecar.json not found (or its sidecar never answered) after ${(timing.attempts * timing.intervalMs) / 1000} s at ${path}; ${describeGiveUp(spawned)}`,
				);
			}
		}
		await sleep(timing.intervalMs);
	}
}

/**
 * Concurrent callers share one in-flight wait (see `waitForSidecarJson` for
 * when it gives up). Only success is cached: a failed attempt leaves nothing behind, so a later call retries instead of being
 * stuck with a permanently cached error.
 */
export function createBackendResolver(
	sidecarJsonPath: string,
	getSpawned: () => SpawnedSidecar | undefined,
): () => Promise<BackendState> {
	let resolved: BackendState | undefined;
	let inFlight: Promise<BackendState> | undefined;
	return async () => {
		if (resolved !== undefined) {
			return resolved;
		}
		if (inFlight === undefined) {
			inFlight = waitForSidecarJson(sidecarJsonPath, getSpawned)
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
