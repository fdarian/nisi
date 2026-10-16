import { dirname } from "node:path";

/**
 * Directory holding the built `main.js`. Not `__dirname`: `bun build` inlines
 * it as the source directory's absolute path at build time, which points at
 * the build machine's checkout once the app is packaged.
 */
export function bundleDir(): string {
	const main = require.main;
	if (main === undefined) {
		throw new Error(
			"require.main is undefined; main.js was not the entry point",
		);
	}
	return dirname(main.filename);
}
