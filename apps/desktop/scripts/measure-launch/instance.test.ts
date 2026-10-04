import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { makeSidecarClient } from "@repo/sidecar-api";
import { Effect } from "effect";
import {
	liveInstance,
	requireInstrumentation,
	selectRunningInstance,
} from "./instance.ts";

test("discovery checks authenticated health and refuses ambiguous live instances", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nisi-measure-detect-"));
	const server = Bun.serve({
		port: 0,
		fetch: (request) => {
			if (request.headers.get("authorization") !== "Bearer test-token")
				return new Response(null, { status: 401 });
			return Response.json({ json: { status: "ok" } });
		},
	});
	try {
		writeFileSync(
			join(dataDir, "sidecar.json"),
			JSON.stringify({ port: Number(server.url.port), token: "test-token" }),
		);
		expect(
			(
				await Effect.runPromise(
					liveInstance(dataDir).pipe(Effect.provide(BunServices.layer)),
				)
			).live,
		).toBe(true);
		await expect(
			Effect.runPromise(
				selectRunningInstance([dataDir, dataDir]).pipe(
					Effect.provide(BunServices.layer),
				),
			),
		).rejects.toThrow("more than one running nisi");
		writeFileSync(
			join(dataDir, "sidecar.json"),
			JSON.stringify({ port: Number(server.url.port), token: "wrong-token" }),
		);
		await expect(
			Effect.runPromise(
				selectRunningInstance([dataDir]).pipe(
					Effect.provide(BunServices.layer),
				),
			),
		).rejects.toThrow("no running nisi for this worktree");
	} finally {
		server.stop(true);
		rmSync(dataDir, { recursive: true });
	}
});

test("instrumentation probes retry early router 404s", async () => {
	const state = { attempts: 0 };
	const server = Bun.serve({
		port: 0,
		fetch: () => {
			state.attempts++;
			return state.attempts === 1
				? new Response("not found", { status: 404 })
				: Response.json({ json: null });
		},
	});
	try {
		await Effect.runPromise(
			requireInstrumentation(
				makeSidecarClient({
					port: Number(server.url.port),
					token: "test-token",
				}),
			),
		);
		expect(state.attempts).toBe(2);
	} finally {
		server.stop(true);
	}
});

test("missing instrumentation reports the restart/rebuild hint", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => new Response(null, { status: 403 }),
	});
	try {
		await expect(
			Effect.runPromise(
				requireInstrumentation(
					makeSidecarClient({
						port: Number(server.url.port),
						token: "test-token",
					}),
				),
			),
		).rejects.toThrow("--cold --rebuild");
	} finally {
		server.stop(true);
	}
});
