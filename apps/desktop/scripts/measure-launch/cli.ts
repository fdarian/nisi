import { join, resolve } from "node:path";
import { Console, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	type BuildStamp,
	buildFingerprint,
	formatBuild,
	readBuildStamp,
	readStamp,
	rebuildReason,
} from "./build.ts";
import { bundlePath, desktopDir } from "./instance.ts";

export const cliScope = [
	...["cli", "git", "logging", "sidecar-api", "db", "bin-resolver"].map(
		(name) => `packages/${name}`,
	),
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"bunfig.toml",
	"patches",
	"apps/desktop/scripts/build-binary.ts",
	":(glob,exclude)**/*.md",
	":(glob,exclude)**/*.test.ts",
	":(glob,exclude)**/test/**",
];

export type MeasurementCli = { path: string; stamp: BuildStamp };

export function formatCli(cli: MeasurementCli): string {
	return `CLI: compiled binary ${cli.path} — ${formatBuild(cli.stamp)}`;
}

export const prepareCli = (managed: boolean) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (managed) {
			const path = join(bundlePath, "Contents/MacOS/nisi-cli");
			const stamp = yield* readBuildStamp(bundlePath);
			if (stamp === undefined || !(yield* fs.exists(path)))
				return yield* Effect.fail(
					new Error("Managed app build is missing its compiled CLI or stamp"),
				);
			return { path, stamp };
		}
		const dir = join(desktopDir, ".data/measure-launch/cli");
		const path = join(dir, "nisi");
		const stampPath = join(dir, "nisi.build-stamp.json");
		const root = resolve(desktopDir, "../..");
		const current = yield* buildFingerprint(root, cliScope);
		const stamp = yield* readStamp(stampPath);
		const reason = rebuildReason(current, stamp, false, yield* fs.exists(path));
		if (reason === undefined && stamp !== undefined) {
			yield* Console.error(
				`Reusing CLI ${formatBuild(stamp)}; HEAD and content hash match`,
			);
			return { path, stamp };
		}
		yield* Console.error(`Rebuilding CLI only: ${reason}`);
		yield* fs.makeDirectory(dir, { recursive: true });
		const child = yield* Effect.try(() =>
			Bun.spawn(
				[
					process.execPath,
					"scripts/build-binary.ts",
					"../../packages/cli/src/index.ts",
					path,
				],
				{ cwd: desktopDir, stdout: 2, stderr: "inherit" },
			),
		);
		const exit = yield* Effect.tryPromise(() => child.exited);
		if (exit !== 0)
			return yield* Effect.fail(new Error(`CLI build failed with ${exit}`));
		const after = yield* buildFingerprint(root, cliScope);
		if (after.head !== current.head || after.hash !== current.hash)
			return yield* Effect.fail(
				new Error(
					"CLI sources changed during build; refusing to stamp an inconsistent binary",
				),
			);
		const built = { ...current, builtAt: new Date().toISOString() };
		yield* fs.writeFileString(stampPath, JSON.stringify(built, null, 2));
		return { path, stamp: built };
	});
