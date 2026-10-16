import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchActivation } from "./activation";
import { shouldFocusMainWindow } from "./measurement-instance";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
});

describe("shouldFocusMainWindow", () => {
	test("only measurement instances skip focus", () => {
		expect(shouldFocusMainWindow(undefined)).toBe(true);
		expect(shouldFocusMainWindow("0")).toBe(true);
		expect(shouldFocusMainWindow("true")).toBe(true);
		expect(shouldFocusMainWindow("1")).toBe(false);
	});
});

describe("watchActivation", () => {
	test("claims a stream that refuses a foreign owner, then activates and acks each message", async () => {
		const events: string[] = [];
		let claimed = false;
		const encoder = new TextEncoder();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			idleTimeout: 0,
			fetch(request) {
				const url = new URL(request.url);
				if (request.headers.get("authorization") !== "Bearer tok") {
					return new Response(null, { status: 401 });
				}
				if (url.pathname === "/api/health/check") {
					return Response.json({ json: { status: "ok" } });
				}
				if (request.headers.get("x-nisi-activation-owner") !== "owner-1") {
					return new Response(null, { status: 400 });
				}
				if (url.pathname === "/native/activation") {
					if (!claimed) {
						return new Response(null, { status: 403 });
					}
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(encoder.encode('\n{"id":"a'));
								setTimeout(
									() => controller.enqueue(encoder.encode('bc"}\n')),
									20,
								);
							},
						}),
					);
				}
				if (url.pathname === "/native/activation/claim") {
					claimed = true;
					events.push("claim");
					return new Response(null, { status: 204 });
				}
				if (url.pathname === "/native/activation/ack") {
					events.push(`ack:${url.searchParams.get("id")}`);
					return new Response(null, { status: 204 });
				}
				return new Response(null, { status: 404 });
			},
		});
		cleanups.push(() => void server.stop(true));
		const dir = mkdtempSync(join(tmpdir(), "nisi-activation-test-"));
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
		const sidecarJsonPath = join(dir, "sidecar.json");
		writeFileSync(
			sidecarJsonPath,
			JSON.stringify({ port: server.port, token: "tok" }),
		);

		const controller = new AbortController();
		const acked = new Promise<void>((resolve) => {
			const watch = watchActivation({
				sidecarJsonPath,
				ownerId: "owner-1",
				activate: () => {
					events.push("activate");
				},
				signal: controller.signal,
			});
			const poll = setInterval(() => {
				if (events.includes("ack:abc")) {
					clearInterval(poll);
					controller.abort();
					watch.then(resolve);
				}
			}, 10);
			cleanups.push(() => clearInterval(poll));
		});
		await acked;

		expect(events).toEqual(["claim", "activate", "ack:abc"]);
	});
});
