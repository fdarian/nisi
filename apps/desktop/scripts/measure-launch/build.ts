import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Console, Effect, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { stopBundle } from "./processes.ts";
import { type Shell, stampFileName, wrapperMarker } from "./shell.ts";

const Stamp = Schema.Struct({
	head: Schema.String,
	hash: Schema.String,
	hasChanges: Schema.Boolean,
	builtAt: Schema.String,
});
export type BuildStamp = typeof Stamp.Type;
const scope = [
	".",
	":(exclude)knowledge/**",
	":(glob,exclude)**/*.md",
	":(exclude)*.md",
	":(exclude)apps/desktop/scripts/measure-launch/**",
];

export const buildFingerprint = (
	root: string,
	paths: readonly string[] = scope,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const head = (yield* Effect.tryPromise(() =>
			Bun.$`git rev-parse HEAD`.cwd(root).text(),
		)).trim();
		const diff = yield* Effect.tryPromise(() =>
			Bun.$`git diff HEAD --binary -- ${paths}`.cwd(root).arrayBuffer(),
		);
		const untracked = (yield* Effect.tryPromise(() =>
			Bun.$`git ls-files --others --exclude-standard -z -- ${paths}`
				.cwd(root)
				.text(),
		))
			.split("\0")
			.filter((path) => path.length > 0)
			.sort();
		const hash = createHash("sha256").update(new Uint8Array(diff));
		for (const path of untracked) {
			const contents = yield* fs.readFile(join(root, path));
			hash.update(`\0${path}\0${contents.length}\0`).update(contents);
		}
		return {
			head,
			hash: hash.digest("hex"),
			hasChanges: diff.byteLength > 0 || untracked.length > 0,
		};
	});

export function rebuildReason(
	current: Pick<BuildStamp, "head" | "hash">,
	stamp: BuildStamp | undefined,
	forced: boolean,
	bundleExists: boolean,
): string | undefined {
	if (forced) return "--rebuild requested";
	if (!bundleExists) return "bundle is missing";
	if (stamp === undefined) return "build stamp is missing";
	if (stamp.head !== current.head)
		return `built on ${stamp.head.slice(0, 7)}, HEAD is ${current.head.slice(0, 7)}`;
	if (stamp.hash !== current.hash)
		return "uncommitted changes differ from the build";
	return undefined;
}

export function formatBuild(stamp: BuildStamp): string {
	return `Build ${stamp.head.slice(0, 7)}${stamp.hasChanges ? ` + uncommitted changes ${stamp.hash.slice(0, 12)}` : ""}`;
}

/** A self-extracting wrapper counts as built; priming extracts it before any measured run. */
export const bundleIsBuilt = (shell: Shell) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (shell.selfExtracting && (yield* fs.exists(wrapperMarker(shell))))
			return true;
		for (const executable of shell.requiredExecutables)
			if (!(yield* fs.exists(join(shell.bundlePath, executable)))) return false;
		return true;
	});

const stampPathFor = (bundle: string) =>
	join(dirname(bundle), stampFileName(bundle));

export const ensureBuild = (
	desktopDir: string,
	shell: Shell,
	forced: boolean,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const root = resolve(desktopDir, "../..");
		const stampPath = stampPathFor(shell.bundlePath);
		const current = yield* buildFingerprint(root);
		const stamp = (yield* fs.exists(stampPath))
			? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stamp))(
					yield* fs.readFileString(stampPath),
				)
			: undefined;
		const reason = rebuildReason(
			current,
			stamp,
			forced,
			yield* bundleIsBuilt(shell),
		);
		if (reason === undefined && stamp !== undefined) {
			yield* Console.error(
				`Reusing ${formatBuild(stamp)}; HEAD and content hash match`,
			);
			return stamp;
		}
		yield* Console.error(`Rebuilding: ${reason}`);
		if (shell.stopBeforeBuild) yield* stopBundle(shell);
		const build = yield* Effect.try(() =>
			Bun.spawn([process.execPath, "run", shell.buildScript], {
				cwd: desktopDir,
				env: { ...process.env, ...shell.buildEnv },
				stdout: 2,
				stderr: "inherit",
			}),
		);
		const exit = yield* Effect.tryPromise(() => build.exited);
		if (exit !== 0)
			return yield* Effect.fail(
				new Error(`Build failed with exit code ${exit}`),
			);
		const after = yield* buildFingerprint(root);
		if (after.head !== current.head || after.hash !== current.hash)
			return yield* Effect.fail(
				new Error(
					"App sources changed during build; refusing to stamp an inconsistent bundle",
				),
			);
		const result = { ...current, builtAt: new Date().toISOString() };
		yield* fs.writeFileString(stampPath, JSON.stringify(result, null, 2));
		return result;
	});

export const readStamp = (path: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (!(yield* fs.exists(path))) return undefined;
		return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Stamp))(
			yield* fs.readFileString(path),
		);
	});

export const readBuildStamp = (bundle: string) =>
	readStamp(stampPathFor(bundle));
