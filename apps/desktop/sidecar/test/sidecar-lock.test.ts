import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Result } from "effect";
import type { FileSystem } from "effect/FileSystem";
import {
	acquireSidecarLock,
	publishSidecarJson,
	releaseSidecarLock,
} from "../sidecar-lock.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/** Runs to a `Result` instead of letting a typed failure reject the promise — see `walkthrough/generate.ts`'s `resolveContext` for why this codebase prefers `Effect.result` over unwrapping a rejected `runPromise`'s cause. */
const runResult = <A, E>(effect: Effect.Effect<A, E, FileSystem>) =>
	Effect.runPromise(
		Effect.result(effect).pipe(Effect.provide(BunServices.layer)),
	);

/** A minimal fake sidecar answering only what `health.check` needs — enough to exercise `isOwnerAlive` without booting the real sidecar. */
const startFakeSidecar = (token: string) => {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname !== "/api/health/check") {
				return new Response("not found", { status: 404 });
			}
			if (req.headers.get("authorization") !== `Bearer ${token}`) {
				return new Response("unauthorized", { status: 401 });
			}
			return Response.json({ json: { status: "ok" } });
		},
	});
	// `Bun.serve`'s type allows `undefined` only for a unix-socket server —
	// this one always binds a TCP port, so this can't actually happen.
	if (server.port === undefined) {
		throw new Error("fake sidecar has no port after Bun.serve");
	}
	return { server, port: server.port };
};

/** Nothing listens on port 1 (privileged, so binding needs root — connecting doesn't) — a deterministic "dead" port with no timing race, unlike bind-then-close. */
const DEAD_PORT = 1;

describe("sidecar-lock", () => {
	let dataDir: string;

	beforeEach(async () => {
		dataDir = await mkdtemp(join(tmpdir(), "nisi-sidecar-lock-test-"));
	});

	afterEach(async () => {
		await rm(dataDir, { recursive: true, force: true });
	});

	test("acquires the lock when none exists, and release removes it", async () => {
		await run(acquireSidecarLock(dataDir, { port: 4000, token: "tok-a" }));

		const lockPath = join(dataDir, "sidecar.lock");
		const content = JSON.parse(await readFile(lockPath, "utf8"));
		expect(content).toEqual({ port: 4000, token: "tok-a" });

		await run(releaseSidecarLock(dataDir));
		await expect(readFile(lockPath, "utf8")).rejects.toThrow();
	});

	test("refuses when the recorded owner is alive, without touching the lock file", async () => {
		const owner = startFakeSidecar("owner-token");
		try {
			await writeFile(
				join(dataDir, "sidecar.lock"),
				JSON.stringify({ port: owner.port, token: "owner-token" }),
			);

			const result = await runResult(
				acquireSidecarLock(dataDir, { port: 9999, token: "challenger" }),
			);

			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure._tag).toBe("SidecarAlreadyRunning");
				expect((result.failure as { readonly port: number }).port).toBe(
					owner.port,
				);
			}

			const content = JSON.parse(
				await readFile(join(dataDir, "sidecar.lock"), "utf8"),
			);
			expect(content).toEqual({ port: owner.port, token: "owner-token" });
		} finally {
			owner.server.stop(true);
		}
	});

	test("recovers from a dead owner by clearing the lock and reacquiring for itself", async () => {
		await writeFile(
			join(dataDir, "sidecar.lock"),
			JSON.stringify({ port: DEAD_PORT, token: "dead-token" }),
		);

		await run(acquireSidecarLock(dataDir, { port: 5555, token: "fresh" }));

		const content = JSON.parse(
			await readFile(join(dataDir, "sidecar.lock"), "utf8"),
		);
		expect(content).toEqual({ port: 5555, token: "fresh" });
	});

	test("two concurrent acquires against an empty data dir — exactly one wins, the other sees the winner as alive", async () => {
		const first = startFakeSidecar("first-token");
		const second = startFakeSidecar("second-token");
		try {
			const [firstResult, secondResult] = await Promise.all([
				runResult(
					acquireSidecarLock(dataDir, {
						port: first.port,
						token: "first-token",
					}),
				),
				runResult(
					acquireSidecarLock(dataDir, {
						port: second.port,
						token: "second-token",
					}),
				),
			]);

			const outcomes = [firstResult, secondResult];
			const winners = outcomes.filter(Result.isSuccess);
			const losers = outcomes.filter(Result.isFailure);
			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(1);

			const winnerPort = Result.isSuccess(firstResult)
				? first.port
				: second.port;
			const loserFailure = losers[0]?.failure as
				| { readonly _tag: string; readonly port: number }
				| undefined;
			expect(loserFailure?._tag).toBe("SidecarAlreadyRunning");
			expect(loserFailure?.port).toBe(winnerPort);
		} finally {
			first.server.stop(true);
			second.server.stop(true);
		}
	});

	test("publishSidecarJson replaces existing content and leaves no temp file behind", async () => {
		const sidecarJsonPath = join(dataDir, "sidecar.json");
		await writeFile(
			sidecarJsonPath,
			JSON.stringify({ port: 1111, token: "stale" }),
		);

		await run(publishSidecarJson(dataDir, { port: 2222, token: "fresh" }));

		const content = JSON.parse(await readFile(sidecarJsonPath, "utf8"));
		expect(content).toEqual({ port: 2222, token: "fresh" });

		const entries = await readdir(dataDir);
		const leftoverTempFiles = entries.filter((name) =>
			name.startsWith(".sidecar.json.tmp-"),
		);
		expect(leftoverTempFiles).toHaveLength(0);
	});
});
