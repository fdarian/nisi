import path from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** Couldn't find an app bundle to launch, or `open` itself failed. */
export class AppLaunchError extends Schema.TaggedErrorClass<AppLaunchError>()(
	"AppLaunchError",
	{ reason: Schema.String },
) {}

/** `tauri.conf.json`'s `productName` — the compiled app bundle's file name. */
const PRODUCT_NAME = "desktop";

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
	for (const candidate of candidates) {
		if (yield* fs.exists(candidate)) {
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
 * if the app is already running this just brings its existing window forward
 * instead of starting a second instance.
 */
export const launchApp = Effect.gen(function* () {
	const appPath = yield* resolveAppPath;
	const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
	const exitCode = yield* Effect.scoped(
		Effect.gen(function* () {
			const handle = yield* spawner.spawn(
				ChildProcess.make("open", ["-a", appPath]),
			);
			return yield* handle.exitCode;
		}),
	);
	if (exitCode !== 0) {
		return yield* new AppLaunchError({
			reason: `"open -a ${appPath}" exited with code ${exitCode}`,
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
);
