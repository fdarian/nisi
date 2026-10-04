import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Logger } from "effect";

export type LaunchMark = {
	at: number;
	source: "cli" | "sidecar" | "frontend";
	name: string;
	[key: string]: unknown;
};

export function traceFilePath(dataDir: string, traceId: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(traceId)) {
		throw new Error("Invalid launch trace ID");
	}
	return join(dataDir, "logs", "launch-traces", `${traceId}.jsonl`);
}

export function appendLaunchMarks(
	dataDir: string,
	traceId: string,
	marks: readonly LaunchMark[],
): void {
	Effect.runSync(
		Effect.try(() => {
			const file = traceFilePath(dataDir, traceId);
			mkdirSync(join(dataDir, "logs", "launch-traces"), { recursive: true });
			// One O_APPEND write per batch keeps CLI and sidecar records from interleaving.
			appendFileSync(
				file,
				marks.map((mark) => `${JSON.stringify(mark)}\n`).join(""),
			);
		}).pipe(
			Effect.catch((error) =>
				Effect.logWarning("Launch trace write failed", { traceId, error }).pipe(
					Effect.provide(
						Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]),
					),
				),
			),
		),
	);
}
