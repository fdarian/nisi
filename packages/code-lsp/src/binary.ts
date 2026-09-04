import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { TsLspBinaryResolutionError } from "./errors.ts";

/** Escape hatch — checked first and used verbatim, same idiom as `@repo/bin-resolver`'s `envOverrideVar` (no existence check; a bad override fails at spawn time with the OS's own error instead of a resolver-specific one). */
const ENV_OVERRIDE = "NISI_TS_LSP_BIN";

/**
 * Bun rewrites `import.meta.url` to this virtual scheme only inside a
 * `bun build --compile` binary — verified empirically (see this package's
 * AGENTS.md, "Binary resolution: dev vs. compiled"). `process.execPath`, by
 * contrast, still returns the real on-disk path either way, which is what
 * {@link resolveCompiledBinary} relies on.
 */
const COMPILED_URL_PREFIX = "file:///$bunfs/";

const isCompiledBinary = (): boolean =>
	import.meta.url.startsWith(COMPILED_URL_PREFIX);

/**
 * Filename Tauri bundles the platform `tsc` binary under, as a sibling of
 * the sidecar executable in the packaged app's `Contents/MacOS/` — a third
 * `externalBin` alongside `sidecar`/`nisi-cli`. That packaging change is a
 * later phase; until it lands, a compiled sidecar has no sibling to find and
 * {@link resolveCompiledBinary} fails with a clear error rather than
 * silently falling back to the dev strategy (which cannot work compiled —
 * see this package's AGENTS.md).
 */
const COMPILED_SIBLING_NAME = "ts-lsp";

/**
 * Dev-only. `typescript/lib/getExePath.js` resolves the exact platform
 * binary (e.g. `@typescript/typescript-darwin-arm64`) the installed
 * `typescript` package would run for its own `tsc` — but it isn't in that
 * package's `exports` map, so `import("typescript/lib/getExePath.js")` as a
 * bare specifier is rejected. Resolving `typescript/package.json` (which
 * *is* exported) and importing the sibling file by absolute path sidesteps
 * the exports map entirely — subpath restrictions only gate bare-specifier
 * resolution, not a direct file:// import.
 */
const resolveDevBinary = (): Effect.Effect<
	string,
	TsLspBinaryResolutionError
> =>
	Effect.tryPromise({
		try: async () => {
			const packageJsonUrl = import.meta.resolve("typescript/package.json");
			const packageDir = dirname(fileURLToPath(packageJsonUrl));
			const getExePathFile = join(packageDir, "lib", "getExePath.js");
			const module_: { default: () => string } = await import(getExePathFile);
			return module_.default();
		},
		catch: (cause) =>
			new TsLspBinaryResolutionError({ strategy: "dev-get-exe-path", cause }),
	});

/**
 * Compiled-mode. `typescript/lib/getExePath.js` cannot run inside a `bun
 * build --compile` binary — it reads its own `package.json` relative to
 * `import.meta.url` (rewritten to a virtual `/$bunfs/...` path with nothing
 * on disk beside it) and calls `import.meta.resolve` on a
 * dynamically-computed specifier, which Bun's bundler has nothing to embed
 * for at build time. The only option left is the sibling binary Tauri
 * bundles next to the sidecar executable — see {@link COMPILED_SIBLING_NAME}.
 */
const resolveCompiledBinary = (): Effect.Effect<
	string,
	TsLspBinaryResolutionError
> =>
	Effect.gen(function* () {
		const candidate = join(dirname(process.execPath), COMPILED_SIBLING_NAME);
		const exists = yield* Effect.sync(() => existsSync(candidate));
		if (!exists) {
			return yield* new TsLspBinaryResolutionError({
				strategy: "compiled-sibling",
				cause: new Error(`no sibling LSP binary at ${candidate}`),
			});
		}
		return candidate;
	});

/**
 * Resolves the absolute path to the TypeScript 7 native LSP binary
 * (invoked as `<path> --lsp --stdio`) to spawn. `NISI_TS_LSP_BIN` wins
 * outright when set; otherwise dev vs. compiled per {@link isCompiledBinary}
 * — the two are not interchangeable, see this package's AGENTS.md.
 */
export const resolveTsLspBinary = (): Effect.Effect<
	string,
	TsLspBinaryResolutionError
> =>
	Effect.gen(function* () {
		const override = process.env[ENV_OVERRIDE];
		if (override !== undefined && override.length > 0) return override;
		return yield* isCompiledBinary()
			? resolveCompiledBinary()
			: resolveDevBinary();
	});
