import { join } from "node:path";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";

export const waitForPrIndex = (
	dataDir: string,
	startedAt: number,
	timeoutMs = 120_000,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const log = yield* fs
				.readFileString(join(dataDir, "logs/sidecar.log"))
				.pipe(
					Effect.map(Option.some),
					Effect.catchTag("PlatformError", (error) =>
						error.reason._tag === "NotFound"
							? Effect.succeed(Option.none<string>())
							: Effect.fail(error),
					),
				);
			if (Option.isSome(log)) {
				for (const line of log.value.split("\n")) {
					const timestamp = /(?:^|\s)timestamp="?([^\s"]+)/.exec(line)?.[1];
					if (timestamp === undefined || !(Date.parse(timestamp) >= startedAt))
						continue;
					if (line.includes('message="PR index refreshed"')) return;
					if (
						line.includes(
							'message="PR index refresh failed; retaining last index"',
						)
					)
						return yield* Effect.fail(
							new Error(
								"PR index refresh failed during warm-up; cannot measure a confirmed hit",
							),
						);
				}
			}
			if (Date.now() >= deadline)
				return yield* Effect.fail(
					new Error("timed out waiting for PR index refresh"),
				);
			yield* Effect.sleep("100 millis");
		}
	});
