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
const appPathOverride = (): string | undefined => {
	const override = process.env.NISI_APP_PATH;
	return override !== undefined && override.length > 0 ? override : undefined;
};

/**
 * An explicit `NISI_DATA_DIR` with nothing answering there means "the sandbox
 * I pointed at isn't up", not "start an app" — `open -n --env NISI_DATA_DIR`
 * on the installed production bundle would boot a second production-identity
 * instance onto a dev sandbox's data. Callers that really mean to cold-start
 * against a custom data dir (the launch-measurement script) already say so
 * with `NISI_APP_PATH` or `NISI_MEASUREMENT_INSTANCE`.
 */
export const dataDirLaunchRefusal = (
	dataDir: string | undefined,
	launchRequested: boolean,
): string | undefined =>
	dataDir === undefined || launchRequested
		? undefined
		: `NISI_DATA_DIR is set to ${dataDir} but no sidecar answers there, so not launching /Applications/nisi.app against it. If this is a dev sandbox, "bun dev" is down or its sidecar.json went missing (restart it); to cold-start an app against this dir anyway, set NISI_APP_PATH.`;

const candidateAppPaths = (): ReadonlyArray<string> => {
	const override = appPathOverride();
	if (override !== undefined) {
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
	const dataDir = Option.getOrUndefined(
		yield* Config.string("NISI_DATA_DIR").pipe(Config.option, Effect.orDie),
	);
	const measurementInstance = yield* Config.string(
		"NISI_MEASUREMENT_INSTANCE",
	).pipe(Config.option, Effect.orDie);
	const refusal = dataDirLaunchRefusal(
		dataDir,
		appPathOverride() !== undefined ||
			Option.getOrUndefined(measurementInstance) === "1",
	);
	if (refusal !== undefined) {
		return yield* new AppLaunchError({ reason: refusal });
	}
	const appPath = yield* resolveAppPath;
	const args = appLaunchArguments(
		appPath,
		dataDir,
		Option.getOrUndefined(measurementInstance) === "1",
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
): string[] {
	return [
		...(dataDir === undefined && !measurementInstance ? [] : ["-n"]),
		...(measurementInstance ? ["-g"] : []),
		...(dataDir === undefined ? [] : ["--env", `NISI_DATA_DIR=${dataDir}`]),
		...(measurementInstance ? ["--env", "NISI_MEASUREMENT_INSTANCE=1"] : []),
		"-a",
		appPath,
	];
}
