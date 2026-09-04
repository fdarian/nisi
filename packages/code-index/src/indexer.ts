import { join, relative } from "node:path";
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

/** Any tsconfig variant — `tsconfig.json`, `tsconfig.base.json`, etc. Deliberately lenient: this only backs the "does this repo have any TypeScript project at all" presence check, not "which directories can scip-typescript index as standalone projects" (see `EXACT_TSCONFIG_FILENAME` below for that, stricter, question). A hyphenated name like `tsconfig-library.json` — a shared base meant to be `extends`ed, not a project of its own — does not match this pattern (no literal dot before the variant suffix), which is exactly the distinction that matters. */
const TSCONFIG_NAME = /^tsconfig(\..+)?\.json$/;

/** Caps how many directories a single filesystem walk (`detectTsConfigPresence` or `collectTsConfigProjectRoots`) will visit — a correctness backstop against a pathological repo layout, not a limit expected to bite in practice (real tsconfigs, if any, are almost always within the first few levels). */
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

/** The one name `tsc -p <dir>` (and therefore scip-typescript's own per-project indexing) actually resolves — unlike `TSCONFIG_NAME`'s lenient presence check, a directory only works as a standalone project root here if it has exactly this file, not a differently-named variant meant to be `extends`ed into one. */
const EXACT_TSCONFIG_FILENAME = "tsconfig.json";

/** `repoRoot` itself is `""` under `node:path`'s `relative`, not `"."` — scip-typescript's own project-display-name logic treats `"."` as special (`projectDisplayName = projectRoot === '.' ? options.cwd : projectRoot`), so this is the one place that distinction has to be made by hand. */
const toProjectArg = (repoRoot: string, projectDir: string): string => {
	const rel = relative(repoRoot, projectDir);
	return rel === "" ? "." : rel;
};

/**
 * Every directory under `repoRoot` (skipping the same build/dependency
 * directories `detectTsConfigPresence` skips) that has its own exact
 * `tsconfig.json` — the project roots scip-typescript can actually index,
 * returned as `-p`-style relative paths from `repoRoot`. Unlike
 * `detectTsConfigPresence`, this walks the *entire* tree up to the budget
 * rather than stopping at the first match, since every project matters
 * here, not just whether one exists. Continues descending into a directory
 * even after finding a project there — nested project references
 * (`packages/foo/tools/tsconfig.json` under `packages/foo/tsconfig.json`,
 * say) are real, and scip-typescript's own `indexedProjects` de-dup (shared
 * across every project passed to one invocation) makes listing an
 * already-reachable nested project harmless rather than a double-index.
 */
const collectTsConfigProjectRoots = (
	fs: FileSystem,
	repoRoot: string,
	path: string,
	budget: { remaining: number },
): Effect.Effect<ReadonlyArray<string>> =>
	Effect.gen(function* () {
		if (budget.remaining <= 0) return [];
		budget.remaining -= 1;

		const entries = yield* fs
			.readDirectory(path)
			.pipe(Effect.catch(() => Effect.succeed(null)));
		if (entries === null) return [];

		const ownProject = entries.includes(EXACT_TSCONFIG_FILENAME)
			? [toProjectArg(repoRoot, path)]
			: [];

		const nested: Array<string> = [];
		for (const entry of entries) {
			if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
			const found = yield* collectTsConfigProjectRoots(
				fs,
				repoRoot,
				join(path, entry),
				budget,
			);
			nested.push(...found);
		}

		return [...ownProject, ...nested];
	});

/**
 * The `scip-typescript index` arguments that select which project(s) to
 * index — three layouts, in priority order:
 *
 * 1. A pnpm workspace (`pnpm-workspace.yaml` present) — `--pnpm-workspaces`,
 *    scip-typescript's own workspace enumeration (`pnpm ls -r ...`
 *    internally). One process, no walk needed on this package's side.
 * 2. Otherwise, every directory under `repoRoot` with its own
 *    `tsconfig.json`, passed as explicit positional project arguments in
 *    one invocation. This covers a plain single-project repo (the walk
 *    finds exactly `repoRoot` itself, i.e. `["."]` — identical to today's
 *    implicit no-args behavior) *and* npm/yarn/bun workspaces and any other
 *    layout whose tsconfigs simply live in subdirectories, uniformly, with
 *    no separate "is this a workspace" detection needed.
 *
 * `--yarn-workspaces`/`--yarn-berry-workspaces` were considered and
 * rejected: verified live, they don't read `package.json`'s `workspaces`
 * field directly — they shell out to a real `yarn workspaces list`/`info`,
 * which fails outright (`yarn: command not found`) on any machine without
 * yarn installed, which is the common case for an npm/bun-based repo. The
 * explicit-project-list form does not have this problem: verified live
 * against a real bun workspace (three projects, no root tsconfig, no
 * `pnpm-workspace.yaml`) that every document's `relativePath` comes back
 * correctly rebased onto `repoRoot` — scip-typescript computes it from its
 * own single `--cwd`, not from each project's own root, so no manual
 * merging of multiple `.scip` outputs is needed either.
 */
export const resolveWorkspaceArgs = (
	repoRoot: string,
): Effect.Effect<ReadonlyArray<string>, never, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		if (yield* isPnpmWorkspace(fs, repoRoot)) return ["--pnpm-workspaces"];

		return yield* collectTsConfigProjectRoots(fs, repoRoot, repoRoot, {
			remaining: MAX_DIRECTORIES_VISITED,
		});
	});

/**
 * Spawns scip-typescript against `repoRoot`, writing the resulting index to
 * `outputPath`. See {@link resolveWorkspaceArgs} for how the project(s) to
 * index are chosen. Only a nonzero exit code (or a failure to spawn at all)
 * is treated as failure — scip-typescript's own stderr chatter (e.g. an
 * empty root `tsconfig.json` `files` array, or one project among several
 * failing while the rest still index fine) is not.
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
			const target = yield* resolveSpawnTarget();
			const workspaceArgs = yield* resolveWorkspaceArgs(repoRoot);

			const invocation = spawnInvocationFor(target, [
				"index",
				...workspaceArgs,
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
