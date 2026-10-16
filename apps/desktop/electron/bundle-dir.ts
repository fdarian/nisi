import { dirname } from "node:path";

/**
 * Directory holding the built `main.js` and `preload.js`. Not `__dirname`/
 * `__filename`/`module.filename`: `bun build` replaces those with the source
 * file's build-time path (it even strips `module.filename`), which points at
 * the build machine's checkout once the app is packaged. And not
 * `require.main`: unpackaged Electron reports its default-app bootstrap there
 * (`filename === "electron"`). `require.resolve` is left alone by bun and asks
 * the real module loader, so it is right in dev and inside `app.asar`.
 *
 * Neither a literal specifier works: bun resolves a missing one at build time
 * and fails, and resolving `./preload.js` made it bundle `preload.ts` into
 * `main.js`. Hence the indirection through a variable. `build:electron` writes
 * `dist-electron/package.json`, so that file is always there at runtime.
 */
export function bundleDir(): string {
	const sibling = ["./", "package.json"].join("");
	return dirname(require.resolve(sibling));
}
