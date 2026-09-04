import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The only project-config name this walk recognizes — `tsc -p <dir>` (and therefore `spawnLspServer`) only resolves an exact `tsconfig.json`, not an `extends`-only variant like `tsconfig.base.json`. */
const TSCONFIG_FILENAME = "tsconfig.json";

/**
 * Walks up from `filePath`'s own directory to the nearest ancestor holding a
 * `tsconfig.json`, returning that ancestor's absolute path — the project
 * root a caller should pass to {@link spawnLspServer} to query `filePath`
 * correctly. `null` when no ancestor (up to the filesystem root) has one.
 *
 * This is the piece `spawnLspServer` itself deliberately doesn't do (see this
 * package's AGENTS.md, "One project root per server") — reference counts
 * aren't stable across project loads, so a caller that wants correct results
 * must scope every query's server to the queried file's *own* project, not a
 * broader or unrelated one. Synchronous and dependency-free (`node:fs`
 * existence checks, same idiom as `binary.ts`'s `isCompiledBinary`), not
 * `Effect`-wrapped: there's no meaningfully fallible I/O here, just a handful
 * of `existsSync` checks walking a short, bounded path upward.
 */
export const resolveProjectRoot = (filePath: string): string | null => {
	let dir = dirname(filePath);
	while (true) {
		if (existsSync(join(dir, TSCONFIG_FILENAME))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null; // reached the filesystem root
		dir = parent;
	}
};
