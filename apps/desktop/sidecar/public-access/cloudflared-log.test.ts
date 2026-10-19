import { expect, test } from "bun:test";
import {
	describeUnexpectedExit,
	isTunnelRegistered,
	parseErrorMessage,
	parseKillSignal,
	parseTunnelUrl,
} from "./cloudflared-log.ts";

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

test("recognises the registered-connection line", () => {
	expect(
		isTunnelRegistered(
			"2026-10-19T11:00:03Z INF Registered tunnel connection connIndex=0 connection=abc event=0 ip=198.41.192.7 location=sin01 protocol=quic",
		),
	).toBe(true);
	expect(isTunnelRegistered("2026-10-19T11:00:01Z INF Starting tunnel")).toBe(
		false,
	);
});

test("strips timestamp and level from an ERR line", () => {
	expect(
		parseErrorMessage(
			'2026-10-19T11:10:38Z ERR Failed to dial a quic connection error="timeout" connIndex=0',
		),
	).toBe('Failed to dial a quic connection error="timeout" connIndex=0');
});

test("ignores lines that are not ERR level", () => {
	expect(
		parseErrorMessage("2026-10-19T11:10:38Z INF all good"),
	).toBeUndefined();
	expect(
		parseErrorMessage("2026-10-19T11:10:38Z WRN ERR in the text"),
	).toBeUndefined();
	expect(parseErrorMessage("ERR")).toBeUndefined();
	expect(parseErrorMessage("")).toBeUndefined();
});

test("reads the signal name out of Effect's exit failure message", () => {
	expect(
		parseKillSignal("Process interrupted due to receipt of signal: 'SIGKILL'"),
	).toBe("SIGKILL");
	expect(parseKillSignal("something else")).toBeUndefined();
});

test("prefers the last ERR message over the exit status", () => {
	expect(
		describeUnexpectedExit("tunnel limit reached", { type: "code", code: 1 }),
	).toBe("tunnel limit reached");
});

test("falls back to the exit code or signal without an ERR line", () => {
	expect(describeUnexpectedExit(undefined, { type: "code", code: 1 })).toBe(
		"cloudflared exited unexpectedly (exit code 1)",
	);
	expect(
		describeUnexpectedExit(undefined, { type: "signal", signal: "SIGKILL" }),
	).toBe("cloudflared exited unexpectedly (signal SIGKILL)");
	expect(
		describeUnexpectedExit(undefined, { type: "signal", signal: undefined }),
	).toBe("cloudflared exited unexpectedly");
});
