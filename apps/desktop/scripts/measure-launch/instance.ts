import { join, resolve } from "node:path";
import { safe } from "@orpc/client";
import { makeSidecarClient } from "@repo/sidecar-api";
import { readSidecarJson } from "deskkit/sidecar";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ensureBuild } from "./build.ts";
import { stopBundle } from "./processes.ts";

export const desktopDir = resolve(import.meta.dir, "../..");
export const bundlePath = join(
	desktopDir,
	"src-tauri/target/release/bundle/macos/nisi.app",
);
export const coldDataDir = join(desktopDir, ".data/measure-launch/data");
export const newPrDataDir = join(
	desktopDir,
	".data/measure-launch/new-pr/data",
);
export const cliPath = resolve(desktopDir, "../../packages/cli/src/index.ts");
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
				typeof error === "object" && error !== null && "data" in error
					? error.data
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

export const runningInstance = Effect.gen(function* () {
	const fs = yield* FileSystem;
	const sessions = join(desktopDir, ".data/sessions");
	const names = (yield* fs.exists(sessions))
		? yield* fs.readDirectory(sessions)
		: [];
	const candidates = [
		coldDataDir,
		newPrDataDir,
		...names.map((name) => join(sessions, name, "data")),
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

export const prepareColdInstance = (rebuild: boolean, newPr = false) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = newPr ? newPrDataDir : coldDataDir;
		const ignored = yield* Effect.tryPromise(() =>
			Bun.$`git check-ignore ${dataDir}`.cwd(desktopDir).quiet().nothrow(),
		);
		if (ignored.exitCode !== 0)
			return yield* Effect.fail(
				new Error("The measurement data dir must be gitignored"),
			);
		yield* ensureBuild(desktopDir, bundlePath, rebuild);
		yield* stopBundle(bundlePath);
		if (newPr && (yield* fs.exists(newPrDataDir))) {
			const real = yield* fs.realPath(newPrDataDir);
			if (real !== newPrDataDir)
				return yield* Effect.fail(
					new Error("Refusing to reset a symlinked new-PR data dir"),
				);
			yield* fs.remove(newPrDataDir, { recursive: true });
		}
		yield* fs.makeDirectory(dataDir, { recursive: true });
		return dataDir;
	});
