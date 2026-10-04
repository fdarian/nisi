import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Logger, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	type LaunchMark,
	traceFilePath,
} from "../../sidecar/launch-trace/file-writer.ts";
import { formatTimeline, formatVisibility } from "./format.ts";
import {
	bundlePath,
	cliPath,
	liveInstance,
	prepareColdInstance,
	requireInstrumentation,
	runningInstance,
	unavailableAppPath,
} from "./instance.ts";
import { parseLaunchOptions } from "./options.ts";

const Mark = Schema.fromJsonString(
	Schema.Record(Schema.String, Schema.Unknown),
);
const program = Effect.gen(function* () {
	const options = yield* Effect.try(() =>
		parseLaunchOptions(process.argv.slice(2)),
	);
	const dataDir = yield* options.cold
		? prepareColdInstance(options.rebuild)
		: runningInstance;
	const fs = yield* FileSystem;
	if (!options.cold && (yield* fs.exists(unavailableAppPath)))
		return yield* Effect.fail(
			new Error(
				`Remove unexpected app at ${unavailableAppPath}; warm-mode fallback must be disabled`,
			),
		);
	const traceId = crypto.randomUUID();
	const file = traceFilePath(dataDir, traceId);
	const child = yield* Effect.try(() =>
		Bun.spawn([process.execPath, cliPath], {
			cwd: options.cwd,
			env: {
				...process.env,
				NISI_LAUNCH_TRACE: traceId,
				NISI_DATA_DIR: dataDir,
				NISI_APP_PATH: options.cold ? bundlePath : unavailableAppPath,
			},
			stdout: options.json ? "ignore" : "inherit",
			stderr: "inherit",
		}),
	);
	const childState: { exit?: number } = {};
	void child.exited.then((exit) => {
		childState.exit = exit;
	});
	const deadline = Date.now() + 60_000;
	const readMarks = Effect.gen(function* () {
		if (!(yield* fs.exists(file))) return [] as LaunchMark[];
		const text = yield* fs.readFileString(file);
		return yield* Effect.forEach(text.split("\n").slice(0, -1), (line) =>
			Schema.decodeUnknownEffect(Mark)(line).pipe(
				Effect.flatMap((mark) => {
					if (
						typeof mark.at !== "number" ||
						typeof mark.name !== "string" ||
						!["cli", "sidecar", "frontend"].includes(String(mark.source))
					)
						return Effect.fail(new Error("Invalid launch mark"));
					return Effect.succeed(mark as LaunchMark);
				}),
			),
		);
	});
	const state = { probed: !options.cold };
	while (Date.now() < deadline) {
		if (!state.probed) {
			const instance = yield* liveInstance(dataDir);
			if (instance.live) {
				yield* requireInstrumentation(instance.client);
				state.probed = true;
			}
		}
		const marks = yield* readMarks;
		if (marks.some((mark) => mark.name === "trace.done")) break;
		if (childState.exit !== undefined && childState.exit !== 0)
			return yield* Effect.fail(
				new Error(
					`nisi exited with ${childState.exit}${options.cold ? "; if the build is stale, rerun with --cold --rebuild" : ""}`,
				),
			);
		yield* Effect.sleep("100 millis");
	}
	const marks = yield* readMarks;
	const observedAt = Date.now();
	yield* Console.log(
		options.json
			? JSON.stringify(marks, null, 2)
			: formatTimeline(marks, observedAt),
	);
	if (options.json) {
		const visibility = formatVisibility(marks, observedAt);
		if (visibility !== undefined) yield* Console.error(visibility);
	}
	if (!marks.some((mark) => mark.name === "trace.done")) {
		if (childState.exit === undefined) child.kill();
		return yield* Effect.fail(new Error(`Launch trace timed out: ${file}`));
	}
	const exit = yield* Effect.tryPromise(() => child.exited);
	if (exit !== 0)
		return yield* Effect.fail(new Error(`nisi exited with ${exit}`));
});
BunRuntime.runMain(
	program.pipe(
		Effect.catchCause((cause) =>
			Effect.logError(cause).pipe(Effect.andThen(Effect.failCause(cause))),
		),
		Effect.provide(BunServices.layer),
		Effect.provide(
			Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]),
		),
	),
	{ disableErrorReporting: true },
);
