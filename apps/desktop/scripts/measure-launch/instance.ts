import { join } from "node:path";
import { safe } from "@orpc/client";
import { makeSidecarClient } from "@repo/sidecar-api";
import { readSidecarJson } from "deskkit/sidecar";
import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ensureBuild } from "./build.ts";
import { stopBundle } from "./processes.ts";
import {
	desktopDir,
	missingChromiumFlags,
	type Shell,
	shells,
	wrapperMarker,
} from "./shell.ts";

export const unavailableAppPath = join(
	desktopDir,
	".data/measure-launch/app-launch-disabled.app",
);

export const instrumentationHint =
	"the running app doesn't have launch-trace instrumentation (restart `bun dev` / rerun with `--cold --rebuild`)";

export const liveInstance = (dataDir: string) =>
	Effect.gen(function* () {
		const handshake = yield* readSidecarJson(dataDir);
		if (handshake === undefined) return { live: false as const, dataDir };
		const client = makeSidecarClient(handshake);
		const health = yield* Effect.promise(() =>
			safe(
				client.health.check(undefined, { signal: AbortSignal.timeout(1000) }),
			),
		);
		return health.isSuccess
			? { live: true as const, dataDir, client }
			: { live: false as const, dataDir };
	});

export const requireInstrumentation = (
	client: ReturnType<typeof makeSidecarClient>,
) =>
	Effect.gen(function* () {
		const deadline = Date.now() + 3000;
		while (true) {
			const result = yield* Effect.promise(() =>
				safe(
					client.diagnostics.launchMarks(
						{ traceId: "instrumentation-probe", marks: [] },
						{ signal: AbortSignal.timeout(1000) },
					),
				),
			);
			if (result.isSuccess) return;
			const error = result.error;
			const response =
				typeof error === "object" && error !== null && "response" in error
					? error.response
					: undefined;
			const notFound =
				(typeof error === "object" &&
					error !== null &&
					"status" in error &&
					error.status === 404) ||
				(typeof response === "object" &&
					response !== null &&
					"status" in response &&
					response.status === 404);
			if (!notFound || Date.now() >= deadline)
				return yield* Effect.fail(new Error(instrumentationHint));
			yield* Effect.sleep("100 millis");
		}
	});

export const runningInstance = (shell: Shell) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const sessions = join(desktopDir, ".data/sessions");
		const names = (yield* fs.exists(sessions))
			? yield* fs.readDirectory(sessions)
			: [];
		const candidates = [
			shell.coldDataDir,
			shell.newPrDataDir,
			// `bun dev` sandboxes run Electron.
			...(shell === shells.electron
				? names.map((name) => join(sessions, name, "data"))
				: []),
		];
		return yield* selectRunningInstance(candidates);
	});

export const selectRunningInstance = (candidates: readonly string[]) =>
	Effect.gen(function* () {
		const results = yield* Effect.forEach(candidates, liveInstance, {
			concurrency: "unbounded",
		});
		const live = results.filter((instance) => instance.live);
		if (live.length === 0)
			return yield* Effect.fail(
				new Error(
					"no running nisi for this worktree — start `bun dev`, or use `--cold`",
				),
			);
		if (live.length > 1)
			return yield* Effect.fail(
				new Error(
					`more than one running nisi for this worktree:\n${live.map((instance) => instance.dataDir).join("\n")}`,
				),
			);
		const instance = live[0];
		if (instance === undefined)
			return yield* Effect.die(new Error("Live instance selection failed"));
		yield* requireInstrumentation(instance.client);
		return instance.dataDir;
	});

/** Only an explicit bundle path is ever given to LaunchServices, never a URL. */
export const openBundle = (shell: Shell, dataDir: string) =>
	Effect.gen(function* () {
		const child = yield* Effect.try(() =>
			Bun.spawn(
				[
					"open",
					"-n",
					"-g",
					"--env",
					`NISI_DATA_DIR=${dataDir}`,
					"--env",
					"NISI_MEASUREMENT_INSTANCE=1",
					"-a",
					shell.bundlePath,
				],
				{ stdout: "ignore", stderr: "inherit" },
			),
		);
		const exit = yield* Effect.tryPromise(() => child.exited);
		if (exit !== 0)
			return yield* Effect.fail(
				new Error(`Managed app launch failed with ${exit}`),
			);
	});

/**
 * Runs a self-extracting bundle once against a throwaway data dir so its first-launch
 * extraction never lands inside a measured run.
 */
export const primeShell = (shell: Shell) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (!shell.selfExtracting || !(yield* fs.exists(wrapperMarker(shell))))
			return;
		yield* Console.error(
			`Priming ${shell.bundlePath}: the first launch extracts the bundle in place`,
		);
		const scratch = yield* fs.makeTempDirectory({ prefix: "nisi-prime-" });
		yield* Effect.gen(function* () {
			yield* openBundle(shell, scratch);
			const deadline = Date.now() + 120_000;
			while (!(yield* liveInstance(scratch)).live) {
				if (Date.now() >= deadline)
					return yield* Effect.fail(
						new Error("Timed out waiting for the priming launch to answer"),
					);
				yield* Effect.sleep("250 millis");
			}
		}).pipe(
			Effect.ensuring(
				stopBundle(shell).pipe(
					Effect.andThen(fs.remove(scratch, { recursive: true })),
					Effect.orDie,
				),
			),
		);
		if (yield* fs.exists(wrapperMarker(shell)))
			return yield* Effect.fail(
				new Error("Priming launched the bundle but it is still the wrapper"),
			);
	});

const requireBuiltFlags = (shell: Shell) =>
	Effect.gen(function* () {
		if (shell.builtChromiumFlags.length === 0) return;
		const fs = yield* FileSystem;
		const missing = yield* fs
			.readFileString(join(shell.bundlePath, "Contents/Resources/build.json"))
			.pipe(
				Effect.flatMap((text) =>
					Effect.try(() =>
						missingChromiumFlags(text, shell.builtChromiumFlags),
					),
				),
			);
		if (missing.length > 0)
			return yield* Effect.fail(
				new Error(
					`${shell.bundlePath} was not built with the measurement Chromium flags (${missing.join(", ")}); rerun with --rebuild`,
				),
			);
	});

export const prepareColdInstance = (
	shell: Shell,
	rebuild: boolean,
	newPr = false,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = newPr ? shell.newPrDataDir : shell.coldDataDir;
		const ignored = yield* Effect.tryPromise(() =>
			Bun.$`git check-ignore ${dataDir}`.cwd(desktopDir).quiet().nothrow(),
		);
		if (ignored.exitCode !== 0)
			return yield* Effect.fail(
				new Error("The measurement data dir must be gitignored"),
			);
		yield* ensureBuild(desktopDir, shell, rebuild);
		yield* primeShell(shell);
		yield* requireBuiltFlags(shell);
		yield* stopBundle(shell);
		if (newPr && (yield* fs.exists(shell.newPrDataDir))) {
			const real = yield* fs.realPath(shell.newPrDataDir);
			if (real !== shell.newPrDataDir)
				return yield* Effect.fail(
					new Error("Refusing to reset a symlinked new-PR data dir"),
				);
			yield* fs.remove(shell.newPrDataDir, { recursive: true });
		}
		yield* fs.makeDirectory(dataDir, { recursive: true });
		return dataDir;
	});
