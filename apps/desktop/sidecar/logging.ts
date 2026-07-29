import { join } from "node:path";
import { getDataDirConfig } from "@repo/db";
import { MinimumLogLevelLayer, rotatingFileLogger } from "@repo/logging";
import { Effect, Layer, Logger } from "effect";

/**
 * `<dataDir>/logs/sidecar.log` — the file half of "stdout goes nowhere in
 * production" (Rust spawns the compiled sidecar fire-and-forget, see
 * `apps/desktop/AGENTS.md`'s "The seam"). Same `dataDir` resolution as the
 * handshake file and `app.db`, so `NISI_DATA_DIR` moves logs along with
 * everything else.
 */
export const logFilePathConfig = getDataDirConfig().pipe(
	Effect.map((dataDir) => join(dataDir, "logs", "sidecar.log")),
);

/**
 * Console (pretty, routed to stderr — same stream the two `console.error`
 * calls this replaced already used) plus the rotating file logger, both
 * active at once so dev's terminal output is unchanged while production
 * gets a durable log for the first time. `LOG_LEVEL` (via
 * `MinimumLogLevelLayer`) gates both identically — there's one verbosity
 * knob, not one per sink.
 */
const consoleAndFileLoggers = Layer.unwrap(
	Effect.gen(function* () {
		const logFilePath = yield* logFilePathConfig;
		const fileLogger = yield* rotatingFileLogger(logFilePath);
		return Logger.layer([Logger.consolePretty({ stderr: true }), fileLogger]);
	}),
);

export const LoggingLive = Layer.mergeAll(
	consoleAndFileLoggers,
	MinimumLogLevelLayer,
);
