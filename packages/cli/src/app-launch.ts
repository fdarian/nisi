import path from "node:path";
import { fileURLToPath } from "node:url";
import { Config, Effect, Option, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** Couldn't find an app bundle to launch, or `open` itself failed. */
export class AppLaunchError extends Schema.TaggedError<AppLaunchError>()(
	"AppLaunchError",
	{ reason: Schema.String },
) {}

/** `tauri.conf.json`'s `productName` — the compiled app bundle's file name. */
const PRODUCT_NAME = "nisi";

/** `src/app-launch.ts` -> `src` -> `cli` -> `packages` -> repo root. */
const repoRoot = () =>
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/**
 * Candidate locations for "the app". nisi has no publish/install channel yet
 * (see root `AGENTS.md`), so a real install under `/Applications` and a
 * locally-built release bundle are both plausible — checked in that order so
 * an eventual real install always wins. `NISI_APP_PATH` overrides both, for
 * tests and ad-hoc use.
 */
const candidateAppPaths = (): ReadonlyArray<string> => {
	const override = process.env.NISI_APP_PATH;
	if (override !== undefined && override.length > 0) {
		return [override];
	}
	return [
		`/Applications/${PRODUCT_NAME}.app`,
		path.join(
			repoRoot(),
			"apps",
			"desktop",
			"src-tauri",
			"target",
			"release",
			"bundle",
			"macos",
			`${PRODUCT_NAME}.app`,
		),
	];
};

const resolveAppPath = Effect.gen(function* () {
	const fs = yield* FileSystem;
	const candidates = candidateAppPaths();
	yield* Effect.logDebug("resolving app path", { candidates });
	for (const candidate of candidates) {
		if (yield* fs.exists(candidate)) {
			yield* Effect.logDebug("resolved app path", { appPath: candidate });
			return candidate;
		}
	}
	return yield* new AppLaunchError({
		reason: `could not find the Nisi app (checked: ${candidates.join(", ")}) — build it with "bunx tauri build" in apps/desktop, or set NISI_APP_PATH`,
	});
});

/**
 * Spawns the app via macOS `open`, which hands off to LaunchServices and
 * exits on its own — no detached-process bookkeeping needed on our side, and
 * A data-dir override requires a fresh instance with that environment, rather
 * than activating another bundle with the same production identifier.
 */
export const launchApp = Effect.gen(function* () {
	const appPath = yield* resolveAppPath;
	const dataDir = Option.getOrUndefined(
		yield* Config.string("NISI_DATA_DIR").pipe(Config.option, Effect.orDie),
	);
	const measurementInstance = yield* Config.string(
		"NISI_MEASUREMENT_INSTANCE",
	).pipe(Config.option, Effect.orDie);
	const speculativeDiff = yield* Config.string("NISI_SPECULATIVE_DIFF").pipe(
		Config.option,
		Effect.orDie,
	);
	const args = appLaunchArguments(
		appPath,
		dataDir,
		Option.getOrUndefined(measurementInstance) === "1",
		Option.getOrUndefined(speculativeDiff),
	);
	yield* Effect.logDebug("spawning app", {
		command: "open",
		args,
	});
	yield* Effect.annotateCurrentSpan({ appPath });
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const exitCode = yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(ChildProcess.make("open", args));
			return yield* handle.exitCode;
		}),
	);
	yield* Effect.annotateCurrentSpan({ exitCode });
	yield* Effect.logDebug("app spawn finished", {
		appPath,
		exitCode,
	});
	if (exitCode !== 0) {
		return yield* new AppLaunchError({
			reason: `open ${JSON.stringify(args)} exited with code ${exitCode}`,
		});
	}
}).pipe(
	Effect.catchTag(
		"PlatformError",
		(cause) =>
			new AppLaunchError({
				reason: `failed to launch the app: ${cause.reason.message}`,
			}),
	),
	Effect.withSpan("cli.app.launch"),
);

export function appLaunchArguments(
	appPath: string,
	dataDir?: string,
	measurementInstance = false,
	speculativeDiff?: string,
): string[] {
	return [
		...(dataDir === undefined && !measurementInstance ? [] : ["-n"]),
		...(measurementInstance ? ["-g"] : []),
		...(dataDir === undefined ? [] : ["--env", `NISI_DATA_DIR=${dataDir}`]),
		...(measurementInstance ? ["--env", "NISI_MEASUREMENT_INSTANCE=1"] : []),
		...(dataDir !== undefined && speculativeDiff !== undefined
			? ["--env", `NISI_SPECULATIVE_DIFF=${speculativeDiff}`]
			: []),
		"-a",
		appPath,
	];
}
