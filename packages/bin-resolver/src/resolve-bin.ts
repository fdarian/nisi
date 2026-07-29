import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Directories a macOS `.app` launched from Finder/`open` won't have on
 * `PATH` — login shell startup files never run for a GUI-launched process,
 * so it inherits roughly `/usr/bin:/bin:/usr/sbin:/sbin` (plus
 * `/usr/local/bin`) regardless of what an interactive shell's `.zshrc`/etc.
 * adds. These are the well-known places a user's shell-installed CLIs (a
 * harness CLI, `git`, `gh`, ...) actually live. Checked only after `PATH`
 * itself, in this order — mirrors Codiff's explicit-candidates approach
 * (`electron/codex.cjs`) rather than sourcing shell rc files, which is slow
 * and has surprising side effects.
 */
export const WELL_KNOWN_BIN_DIRS: ReadonlyArray<string> = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	join(homedir(), ".bun/bin"),
	join(homedir(), ".local/bin"),
];

const pathDirs = (path: string | undefined): ReadonlyArray<string> =>
	(path ?? "").split(":").filter((dir) => dir.length > 0);

/** The first `<dir>/<name>` that exists on disk, checked in `dirs` order. */
export function findExecutable(
	name: string,
	dirs: ReadonlyArray<string>,
	exists: (path: string) => boolean = existsSync,
): string | undefined {
	for (const dir of dirs) {
		const candidate = join(dir, name);
		if (exists(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Resolves `name` to an absolute executable path for spawning directly —
 * checked in order: `envOverrideVar` (an explicit escape hatch, e.g. for
 * tests or a user's non-standard install), `PATH`'s own directories, then
 * `WELL_KNOWN_BIN_DIRS`. Falls back to the bare `name` when nothing on disk
 * matches, so spawning still fails with the OS's own "command not found"
 * instead of a resolver-specific error masking it.
 */
export function resolveBin(name: string, envOverrideVar?: string): string {
	const override =
		envOverrideVar === undefined ? undefined : process.env[envOverrideVar];
	if (override !== undefined && override.length > 0) return override;

	return (
		findExecutable(name, [
			...pathDirs(process.env.PATH),
			...WELL_KNOWN_BIN_DIRS,
		]) ?? name
	);
}

export type BinaryAvailability = {
	readonly available: boolean;
	/** The resolved absolute path when found — lets a caller show *which* binary it picked, e.g. to disambiguate a Homebrew install from a `.bun/bin` one. `null` when unavailable. */
	readonly path: string | null;
};

/**
 * Same resolution order as `resolveBin` (env override, then `PATH`, then
 * `WELL_KNOWN_BIN_DIRS`), but reports whether `name` genuinely exists on disk
 * instead of falling back to a bare name that would only fail later at spawn
 * time. This is what "available" means — is the binary actually present —
 * as distinct from `resolveBin`'s "best path to try spawning": an env
 * override pointing at a missing file is unavailable here, whereas
 * `resolveBin` still hands that override to the spawner verbatim and lets
 * the OS report the failure.
 */
export function checkBinAvailability(
	name: string,
	envOverrideVar?: string,
	exists: (path: string) => boolean = existsSync,
): BinaryAvailability {
	const override =
		envOverrideVar === undefined ? undefined : process.env[envOverrideVar];
	if (override !== undefined && override.length > 0) {
		return exists(override)
			? { available: true, path: override }
			: { available: false, path: null };
	}

	const found = findExecutable(
		name,
		[...pathDirs(process.env.PATH), ...WELL_KNOWN_BIN_DIRS],
		exists,
	);
	return found === undefined
		? { available: false, path: null }
		: { available: true, path: found };
}

/**
 * `PATH` extended with whichever `WELL_KNOWN_BIN_DIRS` exist on disk and
 * aren't already present. For handing to a spawned process's own `env.PATH`
 * when the process runs an arbitrary shell command rather than one known
 * binary (e.g. a bootstrap script that itself resolves further tools by bare
 * name) — `resolveBin` can't help there since there's no single binary to
 * resolve up front.
 */
export function resolvedPath(): string {
	const current = pathDirs(process.env.PATH);
	const currentSet = new Set(current);
	const additions = WELL_KNOWN_BIN_DIRS.filter(
		(dir) => !currentSet.has(dir) && existsSync(dir),
	);
	return [...current, ...additions].join(":");
}
