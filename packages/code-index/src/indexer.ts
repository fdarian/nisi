import { join } from "node:path";
import { Effect, Stream } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnTarget, spawnInvocationFor } from "./bootstrap.ts";
import {
	ScipTypescriptIndexError,
	type ScipTypescriptInstallError,
} from "./errors.ts";

/** Directories never worth descending into while looking for a `tsconfig*.json` — build output and dependency trees, which can be enormous and never contain a project's own config. */
const SKIPPED_DIRECTORY_NAMES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".turbo",
	".next",
	".cache",
	"coverage",
]);

const TSCONFIG_NAME = /^tsconfig(\..+)?\.json$/;

/** Caps how many directories a single `detectTsConfigPresence` walk will visit — a correctness backstop against a pathological repo layout, not a limit expected to bite in practice (a real tsconfig, if any, is almost always within the first few levels). */
const MAX_DIRECTORIES_VISITED = 4_000;

const walkForTsConfig = (
	fs: FileSystem,
	path: string,
	budget: { remaining: number },
): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		if (budget.remaining <= 0) return false;
		budget.remaining -= 1;

		// `readDirectory` fails on a file (or anything unreadable) — treated
		// as "nothing found here" rather than propagated, since a directory
		// walk that gives up early on one unreadable subtree shouldn't fail
		// the whole presence check.
		const entries = yield* fs
			.readDirectory(path)
			.pipe(Effect.catch(() => Effect.succeed(null)));
		if (entries === null) return false;

		if (entries.some((entry) => TSCONFIG_NAME.test(entry))) return true;

		for (const entry of entries) {
			if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
			const found = yield* walkForTsConfig(fs, join(path, entry), budget);
			if (found) return true;
		}
		return false;
	});

/**
 * Whether `repoRoot` has a `tsconfig*.json` anywhere outside build output
 * and dependency directories — backs the `status` contract's `unsupported`
 * outcome (a repo with no TypeScript project has nothing for this feature
 * to index). Bounded, best-effort: a filesystem error partway through a
 * walk is treated as "nothing found there," not surfaced as a failure —
 * this is a presence check, not something a caller needs to distinguish
 * "genuinely absent" from "couldn't finish looking."
 */
export const detectTsConfigPresence = (
	repoRoot: string,
): Effect.Effect<boolean, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		return yield* walkForTsConfig(fs, repoRoot, {
			remaining: MAX_DIRECTORIES_VISITED,
		});
	});

const isPnpmWorkspace = (
	fs: FileSystem,
	repoRoot: string,
): Effect.Effect<boolean> =>
	fs
		.exists(join(repoRoot, "pnpm-workspace.yaml"))
		.pipe(Effect.catch(() => Effect.succeed(false)));

/**
 * Spawns scip-typescript against `repoRoot`, writing the resulting index to
 * `outputPath`. Passes `--pnpm-workspaces` only when `repoRoot` actually has
 * a `pnpm-workspace.yaml` — nisi reviews arbitrary repos, not just its own,
 * so this stays correct for a plain single-project repo instead of always
 * assuming a pnpm workspace. Only a nonzero exit code (or a failure to spawn
 * at all) is treated as failure — scip-typescript's own stderr chatter
 * (e.g. an empty root `tsconfig.json` `files` array) is not.
 */
export const buildIndex = (
	repoRoot: string,
	outputPath: string,
): Effect.Effect<
	void,
	ScipTypescriptInstallError | ScipTypescriptIndexError,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const fs = yield* FileSystem;
			const target = yield* resolveSpawnTarget();
			const usesPnpmWorkspaces = yield* isPnpmWorkspace(fs, repoRoot);

			const invocation = spawnInvocationFor(target, [
				"index",
				...(usesPnpmWorkspaces ? ["--pnpm-workspaces"] : []),
				"--output",
				outputPath,
			]);

			yield* Effect.logInfo("running scip-typescript", {
				repoRoot,
				command: invocation.command,
				args: invocation.args,
			});

			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner
				.spawn(
					ChildProcess.make(invocation.command, invocation.args, {
						cwd: repoRoot,
					}),
				)
				.pipe(
					Effect.mapError(
						(cause) =>
							new ScipTypescriptIndexError({
								exitCode: null,
								stderr: "",
								cause,
							}),
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
					(cause) =>
						new ScipTypescriptIndexError({ exitCode: null, stderr: "", cause }),
				),
			);

			if (exitCode !== 0) {
				return yield* new ScipTypescriptIndexError({
					exitCode,
					stderr,
					cause: new Error(
						`scip-typescript index exited ${exitCode} for ${repoRoot}: ${stderr}`,
					),
				});
			}

			yield* Effect.logInfo("scip-typescript finished", {
				repoRoot,
				outputPath,
			});
		}),
	);
