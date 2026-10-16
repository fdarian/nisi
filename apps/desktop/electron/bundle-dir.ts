import { dirname } from "node:path";

/**
 * Directory holding the built `main.js` and `preload.js`. Not `__dirname`/
 * `__filename`/`module.filename`: `bun build` replaces those with the source
 * file's build-time path (it even strips `module.filename`), which points at
 * the build machine's checkout once the app is packaged. And not
 * `require.main`: unpackaged Electron reports its default-app bootstrap there
 * (`filename === "electron"`). `require.resolve` is left alone by bun and asks
 * the real module loader, so it is right in dev and inside `app.asar`.
 */
export function bundleDir(): string {
	return dirname(require.resolve("./preload.js"));
}
