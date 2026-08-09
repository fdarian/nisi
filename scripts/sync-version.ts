#!/usr/bin/env bun
/**
 * Propagates `apps/desktop/package.json`'s version (the source of truth —
 * Changesets bumps it directly) into the two other places a release version
 * has to match: the Tauri config and the Rust crate. Run via `ci:version`
 * right after `changeset version`, never by hand.
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

async function syncTauriConf(version: string): Promise<void> {
	const confPath = path.join(desktopDir, "src-tauri/tauri.conf.json");
	const conf = await Bun.file(confPath).text();
	// Targeted replace, not a JSON.parse/stringify round-trip — the latter
	// reformats every line to the serializer's own layout (e.g. collapsing
	// `{ "x": 12, "y": 24 }` onto separate lines) and turns this into a
	// whole-file diff instead of a one-line version bump.
	const versionLine = /"version": "[^"]*"/;
	if (!versionLine.test(conf)) {
		throw new Error(`Missing "version" field in ${confPath}`);
	}
	await Bun.write(
		confPath,
		conf.replace(versionLine, `"version": "${version}"`),
	);
}

async function syncCargoToml(version: string): Promise<void> {
	const cargoTomlPath = path.join(desktopDir, "src-tauri/Cargo.toml");
	const cargoToml = await Bun.file(cargoTomlPath).text();
	// The `[package]` table's own `version` line is the first `^version = "..."`
	// match in the file — dependency versions are always inline (`tauri = { version = "2" }`),
	// never a standalone line — so a non-global replace targets exactly it.
	const versionLine = /^version = "[^"]*"/m;
	if (!versionLine.test(cargoToml)) {
		throw new Error(`Could not find a "version" field in ${cargoTomlPath}`);
	}
	await Bun.write(
		cargoTomlPath,
		cargoToml.replace(versionLine, `version = "${version}"`),
	);
}

/** Reconciles Cargo.lock's recorded version for the `nisi` crate without a full rebuild. */
function refreshCargoLock(): void {
	const manifestPath = path.join(desktopDir, "src-tauri/Cargo.toml");
	const result = Bun.spawnSync([
		"cargo",
		"metadata",
		"--manifest-path",
		manifestPath,
		"--format-version",
		"1",
	]);
	if (result.exitCode !== 0) {
		throw new Error(
			`cargo metadata failed to refresh Cargo.lock (exit ${result.exitCode}): ${result.stderr.toString()}`,
		);
	}
}

const version = await readDesktopVersion();
await syncTauriConf(version);
await syncCargoToml(version);
refreshCargoLock();

console.log(`Synced version ${version} into tauri.conf.json and Cargo.toml`);
