import { homedir } from "node:os";
import { join } from "node:path";
import {
	checkBinAvailability,
	resolveBin,
	resolvedPath,
} from "@repo/bin-resolver";
import { Effect, Schema, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ScipTypescriptInstallError } from "./errors.ts";

const PACKAGE_NAME = "@sourcegraph/scip-typescript";
const PACKAGE_VERSION = "0.4.0";
const PACKAGE_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

/**
 * Outside any pnpm workspace on purpose — same reasoning as
 * `@repo/harness-local`'s `~/.nisi/harness-sandbox`: an install that runs
 * inside nisi's own checkout fights pnpm's `enableGlobalVirtualStore`
 * linking. Shared across dev/prod and every repo nisi reviews, since this
 * only ever holds one pinned tool version at a time.
 */
const INSTALL_ROOT = join(homedir(), ".nisi", "tools", "scip-typescript");

/** Version-stamped so bumping `PACKAGE_VERSION` here naturally invalidates a stale install instead of needing its own migration. */
const MARKER_PATH = join(INSTALL_ROOT, `.installed-${PACKAGE_VERSION}.ok`);

/**
 * Resolved once per process, same idiom as `packages/git/src/exec.ts`'s
 * `GIT_BIN`/`GH_BIN`. Only ever the escape hatch (`NISI_SCIP_TYPESCRIPT_BIN`)
 * or a `scip-typescript` the user happens to already have globally
 * installed — nothing installs this the way Homebrew installs git/gh, so
 * `resolveSpawnTarget` below only trusts this when {@link hasUsableSystemBin}
 * confirms it's genuinely there, and otherwise bootstraps nisi's own pinned
 * copy instead of spawning the bare fallback name `resolveBin` would
 * otherwise return.
 */
const SYSTEM_BIN = resolveBin("scip-typescript", "NISI_SCIP_TYPESCRIPT_BIN");

const hasUsableSystemBin = (): boolean =>
	checkBinAvailability("scip-typescript", "NISI_SCIP_TYPESCRIPT_BIN").available;

/**
 * `node`/`npm` for provisioning and running the pinned copy. Resolved the
 * same way as `scip-typescript` itself — a GUI-launched `.app` doesn't have
 * either on `PATH` (no login shell startup files ever run), which is also
 * why the pinned copy is always run as `node <entry.js>` rather than
 * executed directly: its `#!/usr/bin/env node` shebang would need `node` on
 * the *child's* `PATH` to resolve, which spawning it as an explicit argument
 * to an already-resolved `node` sidesteps entirely.
 */
const NODE_BIN = resolveBin("node", "NISI_NODE_BIN");
const NPM_BIN = resolveBin("npm", "NISI_NPM_BIN");

/** What to spawn to run scip-typescript, decided once per `resolveSpawnTarget` call — never a bare, unverified name (see {@link SYSTEM_BIN}'s doc). */
export type ScipTypescriptSpawnTarget =
	| { readonly kind: "executable"; readonly command: string }
	| {
			readonly kind: "script";
			readonly command: string;
			readonly scriptPath: string;
	  };

const PackageJsonBin = Schema.fromJsonString(
	Schema.Struct({ bin: Schema.String }),
);

/** Reads the pinned install's own `package.json` to find its entry script, rather than hardcoding scip-typescript 0.4.0's current `dist/src/main.js` — robust to that path changing in a future pinned-version bump. */
const resolveEntryScript = (
	fs: FileSystem,
): Effect.Effect<string, ScipTypescriptInstallError> =>
	Effect.gen(function* () {
		const packageDir = join(INSTALL_ROOT, "node_modules", PACKAGE_NAME);
		const raw = yield* fs
			.readFileString(join(packageDir, "package.json"))
			.pipe(
				Effect.mapError(
					(cause) =>
						new ScipTypescriptInstallError({ step: "resolve-entry", cause }),
				),
			);
		const decoded = yield* Schema.decodeUnknownEffect(PackageJsonBin)(raw).pipe(
			Effect.mapError(
				(cause) =>
					new ScipTypescriptInstallError({ step: "resolve-entry", cause }),
			),
		);
		return join(packageDir, decoded.bin);
	});

/**
 * `npm install --prefix INSTALL_ROOT` for the pinned package spec, widening
 * the child's `PATH` (`resolvedPath()`) since `npm`'s own bin is itself a
 * `#!/usr/bin/env node` shebang script that needs to resolve `node` the same
 * way this module does. `--no-save`/`--no-package-lock` because
 * `INSTALL_ROOT` isn't a project anyone edits — there's nothing to save a
 * manifest for.
 */
const installPinnedCopy = (
	fs: FileSystem,
): Effect.Effect<
	void,
	ScipTypescriptInstallError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* fs
				.makeDirectory(INSTALL_ROOT, { recursive: true })
				.pipe(
					Effect.mapError(
						(cause) =>
							new ScipTypescriptInstallError({ step: "install", cause }),
					),
				);

			yield* Effect.logInfo("installing pinned scip-typescript copy", {
				spec: PACKAGE_SPEC,
				installRoot: INSTALL_ROOT,
			});

			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner
				.spawn(
					ChildProcess.make(
						NPM_BIN,
						[
							"install",
							"--no-save",
							"--no-package-lock",
							"--no-audit",
							"--no-fund",
							"--prefix",
							INSTALL_ROOT,
							PACKAGE_SPEC,
						],
						{
							cwd: INSTALL_ROOT,
							env: { PATH: resolvedPath() },
							extendEnv: true,
						},
					),
				)
				.pipe(
					Effect.mapError(
						(cause) =>
							new ScipTypescriptInstallError({ step: "install", cause }),
					),
				);

			const [stderr, exitCode] = yield* Effect.all(
				[
					Stream.decodeText(handle.stderr).pipe(Stream.mkString),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			).pipe(
				Effect.mapError(
					(cause) => new ScipTypescriptInstallError({ step: "install", cause }),
				),
			);

			if (exitCode !== 0) {
				return yield* new ScipTypescriptInstallError({
					step: "install",
					cause: new Error(
						`npm install ${PACKAGE_SPEC} into ${INSTALL_ROOT} exited ${exitCode}: ${stderr}`,
					),
				});
			}

			yield* fs
				.writeFileString(MARKER_PATH, new Date().toISOString())
				.pipe(
					Effect.mapError(
						(cause) =>
							new ScipTypescriptInstallError({ step: "install", cause }),
					),
				);
		}),
	);

/**
 * Ensures the pinned copy is installed (a no-op past the first successful
 * call — {@link MARKER_PATH} guards it) and resolves its entry script.
 */
const ensurePinnedInstall = (): Effect.Effect<
	string,
	ScipTypescriptInstallError,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const alreadyInstalled = yield* fs
			.exists(MARKER_PATH)
			.pipe(
				Effect.mapError(
					(cause) => new ScipTypescriptInstallError({ step: "install", cause }),
				),
			);
		if (!alreadyInstalled) {
			yield* installPinnedCopy(fs);
		}
		return yield* resolveEntryScript(fs);
	});

/**
 * What to spawn to run `scip-typescript`: the escape hatch or a genuinely
 * present system install, spawned directly (its own shebang resolves fine
 * in whatever environment made it resolvable in the first place — a dev
 * terminal, a test harness); otherwise nisi's own pinned copy, installed on
 * first use and always spawned as `node <entry.js>` (see {@link NODE_BIN}'s
 * doc for why).
 */
export const resolveSpawnTarget = (): Effect.Effect<
	ScipTypescriptSpawnTarget,
	ScipTypescriptInstallError,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	hasUsableSystemBin()
		? Effect.succeed({ kind: "executable", command: SYSTEM_BIN })
		: ensurePinnedInstall().pipe(
				Effect.map(
					(scriptPath) =>
						({ kind: "script", command: NODE_BIN, scriptPath }) as const,
				),
			);

/** The `[command, ...args]` split to actually spawn for `target` running scip-typescript with `scipArgs`. */
export const spawnInvocationFor = (
	target: ScipTypescriptSpawnTarget,
	scipArgs: ReadonlyArray<string>,
): { readonly command: string; readonly args: ReadonlyArray<string> } =>
	target.kind === "executable"
		? { command: target.command, args: scipArgs }
		: { command: target.command, args: [target.scriptPath, ...scipArgs] };
