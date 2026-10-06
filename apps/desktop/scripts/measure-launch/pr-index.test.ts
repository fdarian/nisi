import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber } from "effect";
import { waitForPrIndex } from "./pr-index.ts";

test("index wait ignores earlier instance successes and failures, and tolerates a missing log", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-index-wait-"));
	const startedAt = Date.parse("2026-10-06T00:00:00Z");
	const line = (at: number, message: string) =>
		`timestamp=${new Date(at).toISOString()} message="${message}"\n`;
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const state = { done: false };
					const waiting = yield* waitForPrIndex(dataDir, startedAt, 2000).pipe(
						Effect.tap(() =>
							Effect.sync(() => {
								state.done = true;
							}),
						),
						Effect.forkScoped,
					);
					yield* Effect.sleep("150 millis");
					expect(state.done).toBe(false);
					yield* Effect.promise(async () => {
						await mkdir(join(dataDir, "logs"));
						await Bun.write(
							join(dataDir, "logs/sidecar.log"),
							line(startedAt - 1000, "PR index refreshed") +
								line(
									startedAt - 500,
									"PR index refresh failed; retaining last index",
								),
						);
					});
					yield* Effect.sleep("150 millis");
					expect(state.done).toBe(false);
					yield* Effect.promise(() =>
						Bun.write(
							join(dataDir, "logs/sidecar.log"),
							line(startedAt + 1000, "PR index refreshed"),
						),
					);
					yield* Fiber.join(waiting);
					expect(state.done).toBe(true);
					yield* Effect.promise(() =>
						Bun.write(
							join(dataDir, "logs/sidecar.log"),
							line(
								startedAt + 2000,
								"PR index refresh failed; retaining last index",
							),
						),
					);
					expect(
						(yield* Effect.exit(waitForPrIndex(dataDir, startedAt)))._tag,
					).toBe("Failure");
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
});
