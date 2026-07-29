import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createLoginShellPathCache } from "./login-shell-path.ts";

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

/**
 * The one production instance of the login-shell probe's memo, shared by
 * every function here — see `login-shell-path.ts` for what it probes and why
 * a shell subprocess beats hardcoding each version manager's directory
 * layout. Module-level because the thing it caches is a property of the
 * machine, not of any one caller.
 */
const loginShellPathCache = createLoginShellPathCache();

/**
 * Discards the memoized login-shell `PATH` so the next resolution re-probes —
 * for a user who installed a runtime (or a harness CLI) *while* nisi was
 * already running, which is otherwise invisible until relaunch. Wired to
 * `walkthrough.refreshHarnesses`, alongside the model-discovery cache's own
 * `force`, so the harness list's refresh button re-checks both at once.
 */
export const refreshLoginShellPath = (): void => {
	loginShellPathCache.refresh();
};

/**
 * The cheap candidates: `PATH` itself, then the well-known dirs. Kept
 * separate from the login-shell ones so `resolveBin`/`checkBinAvailability`
 * can try these first and only pay for a shell subprocess when they come up
 * empty — in dev (a terminal-launched sidecar, whose `PATH` already has
 * everything) the probe then never runs at all.
 */
const cheapCandidateDirs = (): ReadonlyArray<string> => [
	...pathDirs(process.env.PATH),
	...WELL_KNOWN_BIN_DIRS,
];

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
 * `findExecutable` over `PATH` + `WELL_KNOWN_BIN_DIRS`, falling back to the
 * user's login-shell `PATH` only when those miss — the shared lookup behind
 * `resolveBin` and `checkBinAvailability`, which differ only in what they do
 * with a miss. The two-stage order is what keeps the shell subprocess off the
 * common path: a version-manager-provided binary (mise, asdf, nvm, fnm,
 * volta) is invisible to stage one in a GUI-launched `.app`, and is exactly
 * what stage two exists to find.
 */
const findOnResolvablePath = (
	name: string,
	exists: (path: string) => boolean,
): string | undefined =>
	findExecutable(name, cheapCandidateDirs(), exists) ??
	findExecutable(name, loginShellPathCache.get(), exists);

/**
 * Resolves `name` to an absolute executable path for spawning directly —
 * checked in order: `envOverrideVar` (an explicit escape hatch, e.g. for
 * tests or a user's non-standard install), `PATH`'s own directories,
 * `WELL_KNOWN_BIN_DIRS`, then the user's login-shell `PATH`. Falls back to
 * the bare `name` when nothing on disk matches, so spawning still fails with
 * the OS's own "command not found" instead of a resolver-specific error
 * masking it.
 */
export function resolveBin(name: string, envOverrideVar?: string): string {
	const override =
		envOverrideVar === undefined ? undefined : process.env[envOverrideVar];
	if (override !== undefined && override.length > 0) return override;

	return findOnResolvablePath(name, existsSync) ?? name;
}

export type BinaryAvailability = {
	readonly available: boolean;
	/** The resolved absolute path when found — lets a caller show *which* binary it picked, e.g. to disambiguate a Homebrew install from a `.bun/bin` one. `null` when unavailable. */
	readonly path: string | null;
};

/**
 * Same resolution order as `resolveBin` (env override, then `PATH`, then
 * `WELL_KNOWN_BIN_DIRS`, then the login-shell `PATH`), but reports whether
 * `name` genuinely exists on disk
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

	const found = findOnResolvablePath(name, exists);
	return found === undefined
		? { available: false, path: null }
		: { available: true, path: found };
}

/**
 * `PATH` extended with whichever `WELL_KNOWN_BIN_DIRS` exist on disk, then
 * with the user's login-shell `PATH`, skipping anything already present. For
 * handing to a spawned process's own `env.PATH` when the process runs an
 * arbitrary shell command rather than one known binary (e.g. a bootstrap
 * script that itself resolves further tools by bare name) — `resolveBin`
 * can't help there since there's no single binary to resolve up front.
 *
 * Unlike `resolveBin`, the login-shell dirs go in unconditionally rather than
 * as a fallback: there's no "not found" signal to trigger on when the caller
 * won't say which binaries the command will reach for. This is what makes
 * `@ai-sdk/harness-opencode`'s `node .../bridge.mjs` spawn work in the
 * packaged app — `node` is commonly version-manager-provided and therefore
 * absent from both `PATH` and `WELL_KNOWN_BIN_DIRS` there. It cost nothing to
 * miss in dev, which is why this went unnoticed: `bun run` prepends its own
 * `node`-shim directory to `PATH` for child processes, so a terminal-launched
 * sidecar resolves `node` even with an otherwise bare `PATH`, while the
 * `bun build --compile` binary the `.app` actually ships does not.
 *
 * Appended after the existing entries, never before, so this only ever adds
 * candidates — a Homebrew tool already on `PATH` keeps winning over a
 * shimmed one.
 */
export function resolvedPath(): string {
	// `new Set` preserves insertion order, so one pass over the concatenation
	// both dedupes and fixes precedence at PATH > well-known > login-shell.
	return [
		...new Set([
			...pathDirs(process.env.PATH),
			...WELL_KNOWN_BIN_DIRS.filter((dir) => existsSync(dir)),
			...loginShellPathCache.get(),
		]),
	].join(":");
}
