import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Duration, Effect, Logger } from "effect";
import { rotatingFileLogger } from "../src/file-logger.ts";

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
	const dir = await mkdtemp(join(tmpdir(), "nisi-logging-test-"));
	try {
		return await fn(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

/** Logs `count` short lines through a `rotatingFileLogger` built with the given `maxBytes`, then flushes (the batch window is tiny so this resolves fast). */
const logLines = (path: string, count: number, maxBytes: number) =>
	Effect.scoped(
		Effect.gen(function* () {
			const logger = yield* rotatingFileLogger(path, {
				maxBytes,
				batchWindow: Duration.millis(10),
			});
			yield* Effect.forEach(
				Array.from({ length: count }, (_, i) => i),
				(i) => Effect.log(`line ${i}`),
				{ discard: true },
			).pipe(Effect.provide(Logger.layer([logger])));
			// One batch window plus slack — `Logger.batched` flushes on its own
			// schedule, not synchronously with each `Effect.log`.
			yield* Effect.sleep(Duration.millis(100));
		}),
	).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

describe("rotatingFileLogger", () => {
	test("writes log lines to the file", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "sub", "sidecar.log");
			await logLines(path, 3, 10 * 1024 * 1024);

			const content = await readFile(path, "utf8");
			expect(content).toContain("line 0");
			expect(content).toContain("line 2");
		});
	});

	test("rotates to a .1 backup once the file passes maxBytes", async () => {
		await withTempDir(async (dir) => {
			const path = join(dir, "sidecar.log");
			// Two separate scopes (two independent `logLines` calls) so there
			// are two separate flushes against the same path — a single flush
			// only ever checks the file's size once, before writing everything
			// it batched, so rotation needs a *second* flush to see the first
			// one's output already past `maxBytes`.
			await logLines(path, 10, 200);
			await logLines(path, 10, 200);

			const rotated = await readFile(`${path}.1`, "utf8");
			expect(rotated.length).toBeGreaterThan(0);
		});
	});
});
