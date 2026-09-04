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
 * Where `apps/desktop/scripts/build-lsp-binary.ts` stages the platform
 * `tsc` binary plus every `lib.*.d.ts` file it needs as direct siblings on
 * disk (see this package's AGENTS.md, "The TS7 binary needs its
 * `lib.*.d.ts` files as siblings") — a directory, not a bare `externalBin`.
 * `tauri.build.conf.json`'s `bundle.macOS.files` copies that whole
 * directory into the packaged app's `Contents/Resources/ts-lsp/` at build
 * time. **Not** `Contents/MacOS/` alongside `sidecar`/`nisi-cli`: `codesign`
 * treats every file under `Contents/MacOS/` as a nested code object
 * requiring its own signature, and a plain-text `.d.ts` file there breaks
 * signing the whole app — reproduced against a real `tauri build`.
 * {@link resolveCompiledBinary} walks up from `process.execPath`
 * (`Contents/MacOS/sidecar`) to `Contents/`, then down into
 * `Resources/ts-lsp/ts-lsp`.
 */
const COMPILED_RESOURCE_DIR = "ts-lsp";
const COMPILED_BINARY_NAME = "ts-lsp";

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
 * for at build time. The only option left is the bundled resource directory
 * Tauri packages alongside the app — see {@link COMPILED_RESOURCE_DIR}.
 * `process.execPath` is `.../Contents/MacOS/sidecar` in a packaged app (it
 * returns the real on-disk path even compiled, unlike `import.meta.url`),
 * so its grandparent is `Contents/`.
 */
const resolveCompiledBinary = (): Effect.Effect<
	string,
	TsLspBinaryResolutionError
> =>
	Effect.gen(function* () {
		const contentsDir = dirname(dirname(process.execPath));
		const candidate = join(
			contentsDir,
			"Resources",
			COMPILED_RESOURCE_DIR,
			COMPILED_BINARY_NAME,
		);
		const exists = yield* Effect.sync(() => existsSync(candidate));
		if (!exists) {
			return yield* new TsLspBinaryResolutionError({
				strategy: "compiled-resource",
				cause: new Error(`no bundled LSP binary at ${candidate}`),
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
