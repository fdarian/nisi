import { dirname, join } from "node:path";
import { Effect, Option, Schema } from "effect";
import type { FileSystem as FileSystemService } from "effect/FileSystem";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { TsLspBinaryResolutionError } from "./errors.ts";
import {
	ensureTsLspBinary,
	type TsLspBinaryInstallError,
} from "./ts-lsp-download.ts";

/** Escape hatch — checked first and used verbatim. */
const ENV_OVERRIDE = "NISI_TS_LSP_BIN";

const TypeScriptPackageJson = Schema.Struct({ version: Schema.String });

type BinaryRequirements =
	| FileSystemService
	| ChildProcessSpawner.ChildProcessSpawner;

const hasMajorVersionSeven = (version: string): boolean =>
	Number.parseInt(version, 10) === 7;

/**
 * Runs the installed TypeScript package's own platform resolver from the
 * candidate worktree package. A missing platform optional package is an
 * unusable local candidate, so callers continue to the pinned cache.
 */
const resolveWorktreeBinary = (
	rootPath: string,
): Effect.Effect<Option.Option<string>, never, FileSystemService> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const packageDir = join(rootPath, "node_modules", "typescript");
		const packageJson = yield* fs
			.readFileString(join(packageDir, "package.json"))
			.pipe(Effect.option);
		if (Option.isNone(packageJson)) return Option.none<string>();

		const decoded = yield* Schema.decodeUnknownEffect(
			Schema.fromJsonString(TypeScriptPackageJson),
		)(packageJson.value).pipe(Effect.option);
		if (
			Option.isNone(decoded) ||
			!hasMajorVersionSeven(decoded.value.version)
		) {
			return Option.none<string>();
		}

		const getExePathFile = join(packageDir, "lib", "getExePath.js");
		const getExePath = yield* Effect.tryPromise({
			try: async () => {
				const module_: { readonly default: () => string } = await import(
					getExePathFile
				);
				return module_.default();
			},
			catch: (cause) => cause,
		}).pipe(Effect.option);
		if (Option.isNone(getExePath)) return Option.none<string>();

		const names = yield* fs
			.readDirectory(dirname(getExePath.value))
			.pipe(Effect.option);
		if (
			Option.isNone(names) ||
			!names.value.some((name) => name.endsWith(".d.ts"))
		) {
			return Option.none<string>();
		}
		return Option.some(getExePath.value);
	});

const resolveCachedBinary = (
	cacheDir: string,
): Effect.Effect<string, TsLspBinaryResolutionError, BinaryRequirements> =>
	ensureTsLspBinary(cacheDir).pipe(
		Effect.mapError(
			(cause: TsLspBinaryInstallError) =>
				new TsLspBinaryResolutionError({
					strategy: cause.reason,
					cause: cause.cause,
				}),
		),
	);

/**
 * Resolves the absolute path to the TypeScript 7 native LSP binary
 * (`<path> --lsp --stdio`) for one worktree. The environment override wins;
 * otherwise a usable worktree-local TypeScript 7 package wins over the
 * process-wide pinned cache.
 */
export const resolveTsLspBinary = (
	rootPath: string,
	cacheDir: string,
): Effect.Effect<string, TsLspBinaryResolutionError, BinaryRequirements> =>
	Effect.gen(function* () {
		const override = process.env[ENV_OVERRIDE];
		if (override !== undefined && override.length > 0) return override;

		const worktreeBinary = yield* resolveWorktreeBinary(rootPath);
		if (Option.isSome(worktreeBinary)) return worktreeBinary.value;
		return yield* resolveCachedBinary(cacheDir);
	});
