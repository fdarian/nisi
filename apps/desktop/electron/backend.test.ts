import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createBackendResolver,
	type SpawnedSidecar,
	waitForSidecarJson,
} from "./backend";

const noSidecar = () => undefined;
const exitedSidecar: SpawnedSidecar = { exitCode: 3, signalCode: null };

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) {
		cleanup();
	}
});

function tempDir(label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `nisi-backend-test-${label}-`));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A fake sidecar answering only a bearer-authed `POST /api/health/check`. */
function fakeSidecar(expectedToken: string): {
	port: number;
	hits: () => number;
} {
	let hits = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request) {
			hits++;
			const url = new URL(request.url);
			if (
				request.method !== "POST" ||
				url.pathname !== "/api/health/check" ||
				request.headers.get("authorization") !== `Bearer ${expectedToken}`
			) {
				return new Response(null, { status: 401 });
			}
			return Response.json({ json: { status: "ok" } });
		},
	});
	cleanups.push(() => void server.stop(true));
	return { port: server.port as number, hits: () => hits };
}

function writeSidecarJson(path: string, port: number, token: string) {
	writeFileSync(path, JSON.stringify({ port, token }));
}

describe("waitForSidecarJson", () => {
	test("resolves immediately when the file is already present and alive", async () => {
		const path = join(tempDir("fresh"), "sidecar.json");
		const sidecar = fakeSidecar("tok-fresh");
		writeSidecarJson(path, sidecar.port, "tok-fresh");

		const start = performance.now();
		const result = await waitForSidecarJson(path, noSidecar);
		const elapsed = performance.now() - start;

		expect(result).toEqual({ port: sidecar.port, token: "tok-fresh" });
		expect(elapsed).toBeLessThan(500);
	});

	test("resolves once the file appears later without blocking the event loop", async () => {
		const path = join(tempDir("delayed"), "sidecar.json");
		const sidecar = fakeSidecar("tok-delayed");

		let ticks = 0;
		const ticker = setInterval(() => ticks++, 50);
		setTimeout(() => writeSidecarJson(path, sidecar.port, "tok-delayed"), 1200);

		const start = performance.now();
		const result = await waitForSidecarJson(path, noSidecar);
		const elapsed = performance.now() - start;
		clearInterval(ticker);

		expect(result.port).toBe(sidecar.port);
		expect(elapsed).toBeGreaterThanOrEqual(1000);
		expect(elapsed).toBeLessThan(3000);
		expect(ticks).toBeGreaterThanOrEqual(15);
	});

	test("keeps polling past a malformed file until a valid one is published", async () => {
		const path = join(tempDir("malformed"), "sidecar.json");
		writeFileSync(path, "not valid json");
		setTimeout(() => {
			const sidecar = fakeSidecar("tok-valid");
			writeSidecarJson(path, sidecar.port, "tok-valid");
		}, 700);

		const start = performance.now();
		const result = await waitForSidecarJson(path, noSidecar);
		const elapsed = performance.now() - start;

		expect(result.token).toBe("tok-valid");
		expect(elapsed).toBeGreaterThanOrEqual(500);
	});

	test("keeps polling past a dead recorded owner until a live one is published", async () => {
		const path = join(tempDir("dead-owner"), "sidecar.json");
		// Nothing answers on port 1, a deterministic "dead" port with no bind-then-close race.
		writeSidecarJson(path, 1, "dead-token");
		setTimeout(() => {
			const sidecar = fakeSidecar("tok-live");
			writeSidecarJson(path, sidecar.port, "tok-live");
		}, 700);

		const start = performance.now();
		const result = await waitForSidecarJson(path, noSidecar);
		const elapsed = performance.now() - start;

		expect(result.token).toBe("tok-live");
		expect(elapsed).toBeGreaterThanOrEqual(500);
	});

	test("keeps waiting past the budget while the spawned sidecar is alive", async () => {
		const path = join(tempDir("alive-child"), "sidecar.json");
		const sidecar = fakeSidecar("tok-slow");
		const running: SpawnedSidecar = { exitCode: null, signalCode: null };
		const timing = { attempts: 3, intervalMs: 20 };
		// 3 x 20 ms is the budget; publish well after it.
		setTimeout(() => writeSidecarJson(path, sidecar.port, "tok-slow"), 250);

		const start = performance.now();
		const result = await waitForSidecarJson(path, () => running, timing);
		const elapsed = performance.now() - start;

		expect(result.token).toBe("tok-slow");
		expect(elapsed).toBeGreaterThanOrEqual(200);
	});

	test("gives up after the budget once the spawned sidecar has exited", async () => {
		const path = join(tempDir("exited-child"), "sidecar.json");
		const running: SpawnedSidecar = { exitCode: null, signalCode: null };
		let child: SpawnedSidecar = running;
		const timing = { attempts: 3, intervalMs: 20 };
		setTimeout(() => {
			child = exitedSidecar;
		}, 100);

		const start = performance.now();
		await expect(waitForSidecarJson(path, () => child, timing)).rejects.toThrow(
			"exited with code 3",
		);
		expect(performance.now() - start).toBeGreaterThanOrEqual(100);
	});

	test("gives up after the budget when no sidecar was spawned", async () => {
		const path = join(tempDir("no-child"), "sidecar.json");
		const timing = { attempts: 3, intervalMs: 20 };

		await expect(waitForSidecarJson(path, noSidecar, timing)).rejects.toThrow(
			"no sidecar is running",
		);
	});
});

describe("createBackendResolver", () => {
	test("concurrent callers share one wait and the result is cached", async () => {
		const path = join(tempDir("resolver"), "sidecar.json");
		const sidecar = fakeSidecar("tok-resolver");
		writeSidecarJson(path, sidecar.port, "tok-resolver");
		const getBackend = createBackendResolver(path, noSidecar);

		const results = await Promise.all([getBackend(), getBackend()]);
		expect(results[0]).toEqual(results[1]);
		expect(sidecar.hits()).toBe(1);

		await getBackend();
		expect(sidecar.hits()).toBe(1);
	});
});
