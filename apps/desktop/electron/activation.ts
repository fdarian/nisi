import { type BackendState, sleep, waitForSidecarJson } from "./backend";

const INITIAL_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const REQUEST_TIMEOUT_MS = 2000;

export interface ActivationOptions {
	sidecarJsonPath: string;
	ownerId: string;
	/** Raises the main window; an error is reported and the message is not acknowledged. */
	activate: () => void;
	signal?: AbortSignal;
}

type Connection = { kind: "stream"; response: Response } | { kind: "claimed" };

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function ownerHeaders(
	backend: BackendState,
	ownerId: string,
): Record<string, string> {
	return {
		authorization: `Bearer ${backend.token}`,
		"x-nisi-activation-owner": ownerId,
	};
}

function isAborted(options: ActivationOptions): boolean {
	return options.signal?.aborted === true;
}

function origin(backend: BackendState): string {
	return `http://127.0.0.1:${backend.port}`;
}

function withTimeout(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

async function connect(
	backend: BackendState,
	options: ActivationOptions,
): Promise<Connection> {
	let response: Response;
	try {
		response = await fetch(`${origin(backend)}/native/activation`, {
			headers: ownerHeaders(backend, options.ownerId),
			signal: options.signal,
		});
	} catch (e) {
		throw new Error(`activation stream connection failed: ${errorMessage(e)}`);
	}
	if (response.ok) {
		return { kind: "stream", response };
	}
	await response.body?.cancel();
	if (response.status !== 403) {
		throw new Error(
			`activation stream returned ${response.status} (check sidecar credentials)`,
		);
	}

	let claim: Response;
	try {
		claim = await fetch(`${origin(backend)}/native/activation/claim`, {
			method: "POST",
			headers: ownerHeaders(backend, options.ownerId),
			signal: withTimeout(options.signal),
		});
	} catch (e) {
		throw new Error(`activation ownership claim failed: ${errorMessage(e)}`);
	}
	await claim.body?.cancel();
	if (claim.ok) {
		return { kind: "claimed" };
	}
	throw new Error(
		`activation owner mismatch: sidecar refused takeover with ${claim.status} (another app may still own its activation stream)`,
	);
}

async function handleMessage(
	backend: BackendState,
	options: ActivationOptions,
	line: string,
): Promise<void> {
	let id: unknown;
	try {
		id = (JSON.parse(line) as { id?: unknown }).id;
	} catch (e) {
		throw new Error(`invalid activation message: ${errorMessage(e)}`);
	}
	if (typeof id !== "string") {
		throw new Error("invalid activation message: missing field `id`");
	}
	try {
		options.activate();
	} catch (e) {
		throw new Error(`failed to activate main window: ${errorMessage(e)}`);
	}

	const url = new URL(`${origin(backend)}/native/activation/ack`);
	url.searchParams.set("id", id);
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: ownerHeaders(backend, options.ownerId),
			signal: withTimeout(options.signal),
		});
	} catch (e) {
		throw new Error(`failed to acknowledge activation: ${errorMessage(e)}`);
	}
	await response.body?.cancel();
	if (!response.ok) {
		throw new Error(`activation acknowledgement returned ${response.status}`);
	}
}

/** Reads NDJSON until the stream ends or errors; `onHandled` fires after each handled message. */
async function readLines(
	backend: BackendState,
	options: ActivationOptions,
	response: Response,
	onHandled: () => void,
): Promise<never> {
	if (response.body === null) {
		throw new Error("activation stream closed");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		let chunk: Awaited<ReturnType<typeof reader.read>>;
		try {
			chunk = await reader.read();
		} catch (e) {
			throw new Error(`activation stream disconnected: ${errorMessage(e)}`);
		}
		if (chunk.done) {
			throw new Error("activation stream closed");
		}
		buffer += decoder.decode(chunk.value, { stream: true });
		for (
			let end = buffer.indexOf("\n");
			end !== -1;
			end = buffer.indexOf("\n")
		) {
			const line = buffer.slice(0, end + 1);
			buffer = buffer.slice(end + 1);
			if (line.trim() === "") {
				continue;
			}
			await handleMessage(backend, options, line);
			onHandled();
		}
	}
}

/**
 * Subscribes to the sidecar's `/native/activation` NDJSON stream for the
 * lifetime of the app (or until `signal` aborts). The backoff resets only after
 * a message was actually handled, so a stream that connects and immediately
 * drops keeps backing off.
 */
export async function watchActivation(
	options: ActivationOptions,
): Promise<void> {
	let retryMs = INITIAL_RETRY_MS;
	while (!isAborted(options)) {
		let failure: unknown;
		try {
			let backend: BackendState;
			try {
				// This loop already retries with backoff, so the bounded wait is enough here.
				backend = await waitForSidecarJson(
					options.sidecarJsonPath,
					() => undefined,
				);
			} catch (e) {
				throw new Error(
					`activation bridge waiting for sidecar: ${errorMessage(e)}`,
				);
			}
			const connection = await connect(backend, options);
			if (connection.kind === "claimed") {
				continue;
			}
			await readLines(backend, options, connection.response, () => {
				retryMs = INITIAL_RETRY_MS;
			});
		} catch (e) {
			failure = e;
		}
		if (isAborted(options)) {
			return;
		}
		console.error(`${errorMessage(failure)}; retrying in ${retryMs} ms`);
		await sleep(retryMs);
		retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
	}
}
