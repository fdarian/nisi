#!/usr/bin/env bun
/**
 * Nothing is left to propagate: electron-builder reads its version straight
 * from `apps/desktop/package.json`, which Changesets bumps directly. Kept as
 * the `ci:version` hook so a release still fails fast on a missing or
 * unparseable version, and as the place to sync anything new that needs to
 * match it. Run via `ci:version` right after `changeset version`.
 */
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const desktopDir = path.join(rootDir, "apps/desktop");

async function readDesktopVersion(): Promise<string> {
	const packageJsonPath = path.join(desktopDir, "package.json");
	const packageJson = JSON.parse(await Bun.file(packageJsonPath).text());
	const version = packageJson.version;
	if (typeof version !== "string" || version.length === 0) {
		throw new Error(`Missing or unparseable "version" in ${packageJsonPath}`);
	}
	return version;
}

const version = await readDesktopVersion();

console.log(`Desktop version ${version}; nothing else to sync`);
