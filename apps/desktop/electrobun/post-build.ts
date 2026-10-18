import { chmodSync, copyFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The CLI, the Homebrew cask, the updater and `scripts/measure-launch` all
 * expect the sidecar and CLI binaries at `Contents/MacOS/{sidecar,nisi-cli}`;
 * `build.copy` can only reach `Contents/Resources/app`.
 *
 * Must be `postBuild`, not `postWrap`: a stable/canary release is a
 * self-extracting wrapper whose first launch replaces itself in place with the
 * app archived at this point, so anything added to the wrapper later is lost.
 */
const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
if (buildDir === undefined || appName === undefined) {
	throw new Error("ELECTROBUN_BUILD_DIR / ELECTROBUN_APP_NAME are not set");
}

for (const binary of ["sidecar", "nisi-cli"]) {
	const destination = join(
		buildDir,
		`${appName}.app`,
		"Contents",
		"MacOS",
		binary,
	);
	copyFileSync(join("binaries", binary), destination);
	chmodSync(destination, 0o755);
}
