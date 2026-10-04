import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { traceFilePath } from "./file-writer.ts";
import { LaunchTrace } from "./service.ts";
import { TracedBunServices } from "./spawner.ts";

test("decorator returns live handles and records the exit without changing it", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nisi-launch-spawner-"));
	try {
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const trace = yield* LaunchTrace;
					yield* trace.activate("spawner-test");
					const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
					const handle = yield* spawner.spawn(
						ChildProcess.make("/bin/sh", ["-c", "exit 7"]),
					);
					expect(Number(yield* handle.exitCode)).toBe(7);
					yield* trace.frontend("spawner-test", [
						{ at: Date.now(), name: "trace.done" },
					]);
				}),
			).pipe(
				Effect.provide(LaunchTrace.layer),
				Effect.provide(TracedBunServices),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
					),
				),
			),
		);
		const marks = await Effect.runPromise(
			Effect.forEach(
				readFileSync(traceFilePath(dataDir, "spawner-test"), "utf8")
					.trim()
					.split("\n"),
				(line) =>
					Schema.decodeUnknownEffect(
						Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
					)(line),
			),
		);
		const spawn = marks.find((mark) => mark.name === "spawn");
		expect(spawn?.command).toBe("/bin/sh");
		expect(spawn?.exitCode).toBe(7);
		expect(spawn?.durationMs).toBeGreaterThanOrEqual(0);
	} finally {
		rmSync(dataDir, { recursive: true });
	}
});
