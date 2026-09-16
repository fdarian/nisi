import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { TS_LSP_RELEASES, TS_LSP_VERSION } from "../src/ts-lsp-download.ts";

const findLockfile = (directory: string): string => {
	const candidate = join(directory, "pnpm-lock.yaml");
	if (existsSync(candidate)) return candidate;

	const parent = dirname(directory);
	if (parent === directory) {
		throw new Error(`could not find pnpm-lock.yaml above ${directory}`);
	}
	return findLockfile(parent);
};

const readPinnedIntegrities = (lockfile: string): Map<string, string> => {
	const text = readFileSync(lockfile, "utf8");
	const pattern = new RegExp(
		`^  '(@typescript/typescript-[^']+)@${TS_LSP_VERSION.replaceAll(".", "\\.")}':\\n    resolution: \\{integrity: ([^}]+)\\}`,
		"gm",
	);
	const integrities = new Map<string, string>();
	for (const match of text.matchAll(pattern)) {
		const packageName = match[1];
		const integrity = match[2];
		if (packageName === undefined || integrity === undefined) {
			throw new Error("lockfile integrity match is missing a capture");
		}
		if (!integrities.has(packageName)) integrities.set(packageName, integrity);
	}
	return integrities;
};

test("every TS LSP integrity pin matches the first lockfile resolution", () => {
	const lockfile = findLockfile(import.meta.dir);
	const integrities = readPinnedIntegrities(lockfile);
	const releases = Object.values(TS_LSP_RELEASES);
	const packageNames = new Set(releases.map((release) => release.packageName));

	expect(releases).toHaveLength(20);
	expect(packageNames.size).toBe(releases.length);
	expect(integrities.size).toBe(packageNames.size);
	for (const release of releases) {
		const lockfileIntegrity = integrities.get(release.packageName);
		if (lockfileIntegrity === undefined) {
			throw new Error(
				`pnpm-lock.yaml has no ${release.packageName}@${TS_LSP_VERSION} resolution`,
			);
		}
		expect(release.integrity).toBe(lockfileIntegrity);
	}
});
