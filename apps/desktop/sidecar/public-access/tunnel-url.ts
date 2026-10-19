const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

/** cloudflared mentions its own API host in log lines; it is never the tunnel. */
const API_HOST_URL = "https://api.trycloudflare.com";

/** The quick-tunnel URL in one line of cloudflared output, if the line announces one. */
export function parseTunnelUrl(line: string): string | undefined {
	for (const match of line.matchAll(TUNNEL_URL)) {
		if (match[0] !== API_HOST_URL) return match[0];
	}
	return undefined;
}
