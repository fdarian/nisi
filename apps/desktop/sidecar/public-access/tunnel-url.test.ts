import { expect, test } from "bun:test";
import { parseTunnelUrl } from "./tunnel-url.ts";

test("finds the URL in the banner line cloudflared prints", () => {
	expect(
		parseTunnelUrl(
			"2026-10-19T11:00:00Z INF |  https://quiet-river-1234.trycloudflare.com  |",
		),
	).toBe("https://quiet-river-1234.trycloudflare.com");
});

test("ignores the API host cloudflared logs while requesting the tunnel", () => {
	expect(
		parseTunnelUrl(
			"INF Requesting new quick Tunnel on trycloudflare.com... url=https://api.trycloudflare.com/tunnel",
		),
	).toBeUndefined();
});

test("skips the API host and takes a tunnel URL on the same line", () => {
	expect(
		parseTunnelUrl(
			"https://api.trycloudflare.com then https://abc-def.trycloudflare.com",
		),
	).toBe("https://abc-def.trycloudflare.com");
});

test("returns undefined for lines without a tunnel URL", () => {
	expect(parseTunnelUrl("INF Starting tunnel")).toBeUndefined();
	expect(parseTunnelUrl("http://abc.trycloudflare.com")).toBeUndefined();
});
