const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

/** cloudflared mentions its own API host in log lines; it is never the tunnel. */
const API_HOST_URL = "https://api.trycloudflare.com";

/** `<timestamp> ERR <message>`, the shape of every error line cloudflared logs. */
const ERROR_LINE = /^\S+\s+ERR\s+(.+)$/;

const KILLED_BY_SIGNAL = /signal: '([A-Z0-9]+)'/;

/** The quick-tunnel URL in one line of cloudflared output, if the line announces one. */
export function parseTunnelUrl(line: string): string | undefined {
	for (const match of line.matchAll(TUNNEL_URL)) {
		if (match[0] !== API_HOST_URL) return match[0];
	}
	return undefined;
}

/**
 * The URL line is printed before the tunnel carries traffic; this line is the
 * first sign that the edge accepted a connection.
 */
export function isTunnelRegistered(line: string): boolean {
	return line.includes("Registered tunnel connection");
}

/** The message of an ERR-level cloudflared log line, without its timestamp and level. */
export function parseErrorMessage(line: string): string | undefined {
	return ERROR_LINE.exec(line)?.[1]?.trim();
}

/**
 * Effect reports a signal-killed child only as a `PlatformError` whose message
 * names the signal; that message is the one place the signal name survives.
 */
export function parseKillSignal(
	platformErrorMessage: string,
): string | undefined {
	return KILLED_BY_SIGNAL.exec(platformErrorMessage)?.[1];
}

export type TunnelExit =
	| { readonly type: "code"; readonly code: number }
	| { readonly type: "signal"; readonly signal: string | undefined };

/** What to tell the user when cloudflared died on its own. */
export function describeUnexpectedExit(
	lastError: string | undefined,
	exit: TunnelExit,
): string {
	if (lastError !== undefined) return lastError;
	if (exit.type === "code") {
		return `cloudflared exited unexpectedly (exit code ${exit.code})`;
	}
	if (exit.signal === undefined) return "cloudflared exited unexpectedly";
	return `cloudflared exited unexpectedly (signal ${exit.signal})`;
}
