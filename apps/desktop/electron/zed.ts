import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The real Zed CLI binary; `/usr/local/bin/zed` is a symlink to it. Checked
 * first because a GUI process doesn't inherit the login shell's `PATH`, so
 * relying on that symlink resolving is unreliable from inside the app.
 */
const BUNDLED_ZED_CLI = "/Applications/Zed.app/Contents/MacOS/cli";

function isExecutableFile(path: string): boolean {
	try {
		const stats = statSync(path);
		return stats.isFile() && (stats.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/**
 * Mimics `which name` over `pathVar`. Resolving up front, instead of letting
 * `spawn` fail, is what lets a missing CLI fall back to the `zed://file` URL
 * instead of surfacing a spawn error to the user.
 */
export function resolveOnPath(
	name: string,
	pathVar: string | undefined,
): string | undefined {
	if (pathVar === undefined) {
		return undefined;
	}
	for (const dir of pathVar.split(delimiter)) {
		const candidate = join(dir, name);
		if (isExecutableFile(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function resolveZedCli(): string | undefined {
	if (isExecutableFile(BUNDLED_ZED_CLI)) {
		return BUNDLED_ZED_CLI;
	}
	return resolveOnPath("zed", process.env.PATH);
}

/**
 * `pr-header.tsx`'s "Open in..." opens the repo root itself, handing this the
 * same value for both; skip the duplicate rather than pass Zed a redundant path.
 */
export function zedArgs(repoRoot: string, path: string): string[] {
	return path === repoRoot ? [repoRoot] : [repoRoot, path];
}

function spawnZedCli(
	cli: string,
	repoRoot: string,
	path: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(cli, zedArgs(repoRoot, path), {
			detached: true,
			stdio: "ignore",
		});
		child.once("error", (e) =>
			reject(new Error(`failed to spawn Zed CLI at ${cli}: ${e.message}`)),
		);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}

/**
 * Opens `repoRoot` and `path` in Zed as one CLI invocation, `zed <repoRoot>
 * <path>`, instead of the `zed://file/<path>` URL every other editor uses:
 * Zed's URL parser accepts exactly one path, so routing a file through it makes
 * the file itself the project root and the repo root is lost. Window reuse is
 * Zed's job; this never tracks windows and never passes `--wait`.
 *
 * With no CLI found it falls back to the URL, a deliberate degraded path that
 * drops the project root, not a swallowed error.
 */
export async function openInZed(
	repoRoot: string,
	path: string,
	openViaUrl: (path: string) => Promise<void>,
): Promise<void> {
	const cli = resolveZedCli();
	if (cli === undefined) {
		console.error(
			`no Zed CLI found (checked ${BUNDLED_ZED_CLI} and PATH) — opening ${path} via zed://file instead, with no project root`,
		);
		return openViaUrl(path);
	}
	return spawnZedCli(cli, repoRoot, path);
}
