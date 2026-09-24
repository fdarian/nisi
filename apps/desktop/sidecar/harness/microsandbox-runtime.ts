import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { getDataDirConfig } from "@repo/db";
import { ensureNpmTarball, NpmTarballInstallError } from "@repo/npm-tarball";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

export const MICROSANDBOX_VERSION = "0.6.18";
export const MICROSANDBOX_INTEGRITY =
	"sha512-C+bz9+v8JXQ6BG0FXbiTywM/dSNjIFifF3fOh5IU3JW3OiB0HcgjBiVRFWpZYk/pV6eKhZTYSkUiIWwYc3SRNA==";

const files = [
	"microsandbox.darwin-arm64.node",
	"bin/msb",
	"lib/libkrunfw.5.dylib",
];
const validate = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		return yield* Effect.all(
			files.map((file) =>
				fs
					.exists(join(directory, file))
					.pipe(
						Effect.mapError(
							(cause) => new NpmTarballInstallError({ reason: "cache", cause }),
						),
					),
			),
		).pipe(Effect.map((results) => results.every(Boolean)));
	});

export const ensureMicrosandboxRuntime = (): Promise<string> => {
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		return Promise.reject(
			new Error(
				`microsandbox runtime is unsupported on ${process.platform}/${process.arch}`,
			),
		);
	}
	return Effect.runPromise(
		Effect.gen(function* () {
			const dataDir = yield* getDataDirConfig();
			return yield* ensureNpmTarball(
				join(dataDir, "microsandbox", MICROSANDBOX_VERSION, "darwin-arm64"),
				{
					packageName: "@superradcompany/microsandbox-darwin-arm64",
					version: MICROSANDBOX_VERSION,
					integrity: MICROSANDBOX_INTEGRITY,
				},
				{ sourceDirectory: "package", executable: "bin/msb", validate },
			);
		}).pipe(Effect.provide(BunServices.layer)),
	);
};

export const loadMicrosandbox = async () => {
	const directory = await ensureMicrosandboxRuntime();
	process.env.NAPI_RS_NATIVE_LIBRARY_PATH = join(
		directory,
		"microsandbox.darwin-arm64.node",
	);
	process.env.MSB_PATH = join(directory, "bin/msb");
	process.env.MSB_LIBKRUNFW_PATH = join(directory, "lib/libkrunfw.5.dylib");
	return import("ai-microsandbox");
};
