import { expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigProvider, Effect, Schema } from "effect";
import { cliMark, initializeLaunchTrace } from "./launch-trace.ts";

test("CLI marks use wall time except the process-start snapshot", async () => {
	const directory = mkdtempSync(join(tmpdir(), "nisi-cli-clock-"));
	const clock = spyOn(Date, "now").mockReturnValue(1234);
	try {
		await Effect.runPromise(
			initializeLaunchTrace.pipe(
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							NISI_DATA_DIR: directory,
							NISI_LAUNCH_TRACE: "clock-test",
						}),
					),
				),
			),
		);
		const marks = await Effect.runPromise(
			Effect.forEach(
				readFileSync(
					join(directory, "logs", "launch-traces", "clock-test.jsonl"),
					"utf8",
				)
					.trim()
					.split("\n"),
				(line) =>
					Schema.decodeUnknownEffect(
						Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
					)(line),
			),
		);
		expect(marks[0]?.at).toBe(performance.timeOrigin);
		expect(marks[1]?.at).toBe(1234);
	} finally {
		clock.mockRestore();
		rmSync(directory, { recursive: true });
	}
});

test("throwing CLI appends and directory creation do not fail real work", async () => {
	const directory = mkdtempSync(join(tmpdir(), "nisi-cli-writer-failure-"));
	try {
		mkdirSync(
			join(directory, "logs", "launch-traces", "append-failure.jsonl"),
			{ recursive: true },
		);
		const blocked = join(directory, "blocked");
		writeFileSync(blocked, "not a directory");
		for (const dataDir of [directory, blocked]) {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					yield* initializeLaunchTrace;
					cliMark("cli.open.response");
					return "real work completed";
				}).pipe(
					Effect.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								NISI_DATA_DIR: dataDir,
								NISI_LAUNCH_TRACE: "append-failure",
							}),
						),
					),
				),
			);
			expect(result).toBe("real work completed");
		}
	} finally {
		rmSync(directory, { recursive: true });
	}
});
