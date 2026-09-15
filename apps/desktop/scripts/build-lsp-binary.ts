import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

/**
 * Resolves the platform TypeScript 7 native LSP binary's absolute path the
 * same way `packages/code-lsp/src/binary.ts`'s dev strategy does:
 * `typescript/lib/getExePath.js` isn't listed in `typescript`'s own
 * `exports` map, so `import("typescript/lib/getExePath.js")` as a bare
 * specifier is rejected. Resolving the exported `typescript/package.json`
 * and importing the sibling file by its resolved absolute path sidesteps
 * the exports map entirely. This script runs as a plain `bun` process (not
 * compiled), so — unlike `binary.ts`'s compiled-mode branch — that strategy
 * works fine here.
 */
const resolvePlatformTscPath = (): Effect.Effect<string> =>
	Effect.promise(async () => {
		const packageJsonUrl = import.meta.resolve("typescript/package.json");
		const packageDir = dirname(fileURLToPath(packageJsonUrl));
		const getExePathFile = join(packageDir, "lib", "getExePath.js");
		const module_: { default: () => string } = await import(getExePathFile);
		return module_.default();
	});

/**
 * Filename the LSP binary is staged under inside `outDir` — matches
 * `packages/code-lsp/src/binary.ts`'s `COMPILED_RESOURCE_NAME`.
 */
const BINARY_NAME = "ts-lsp";

/**
 * Copies the platform `tsc` binary — already a native executable, nothing
 * to `bun build --compile` here unlike `build-binary.ts`'s targets — plus
 * every `lib.*.d.ts` declaration file that ships beside it in the npm
 * package, both into one flat `outDir`. Both matter, and both must land in
 * the *same* directory: the LSP server panics on boot ("bundled:
 * .../lib.d.ts does not exist; this executable may be misplaced") unless
 * those declaration files are direct siblings of its own executable on
 * disk — verified empirically to be `dirname(os.Executable())` and nothing
 * else, no `CWD` or `../Resources` fallback.
 *
 * `outDir` is *not* shipped as a Tauri `externalBin` (unlike `sidecar`/
 * `nisi-cli`) — `externalBin` always stages into the packaged app's
 * `Contents/MacOS/`, and `codesign` treats every file it finds there as a
 * nested code object requiring its own valid signature. A plain-text
 * `.d.ts` file has none, and signing the whole app then fails outright
 * ("code object is not signed at all... In subcomponent:
 * .../Contents/MacOS/lib.es2015.core.d.ts" — reproduced against a real
 * `tauri build`). `tauri.build.conf.json`'s `bundle.macOS.files` instead
 * copies this whole directory, binary and declaration files together, into
 * `Contents/Resources/ts-lsp/` — a location `codesign` treats as ordinary
 * bundle resources, not nested code, while still auto-discovering and
 * properly signing the nested `ts-lsp` executable inside it.
 */
const buildLspBinary = (outDir: string) =>
	Effect.gen(function* () {
		const tscPath = yield* resolvePlatformTscPath();
		const tscDir = dirname(tscPath);

		yield* Effect.sync(() => mkdirSync(outDir, { recursive: true }));
		yield* Effect.sync(() => copyFileSync(tscPath, join(outDir, BINARY_NAME)));

		const libFiles = (yield* Effect.sync(() => readdirSync(tscDir))).filter(
			(name) => name.endsWith(".d.ts"),
		);
		if (libFiles.length === 0) {
			return yield* Effect.fail(
				new Error(`no lib .d.ts files found beside ${tscPath}`),
			);
		}

		yield* Effect.forEach(libFiles, (name) =>
			Effect.sync(() => copyFileSync(join(tscDir, name), join(outDir, name))),
		);
	});

const outDir = process.argv[2];
if (outDir === undefined) {
	console.error("usage: build-lsp-binary.ts <out-dir>");
	process.exit(1);
}

buildLspBinary(outDir).pipe(BunRuntime.runMain);
