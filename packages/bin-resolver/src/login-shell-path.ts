import { execFileSync } from "node:child_process";

/**
 * Wraps the probe's `PATH` in stdout so rc-file chatter around it (a greeting
 * banner, a version-manager's activation notice, `motd`-style output) can be
 * discarded instead of being parsed as directories. Everything between the
 * first and second occurrence is the `PATH` and nothing else.
 */
const DELIMITER = "__NISI_LOGIN_SHELL_PATH__";

/**
 * A login+interactive shell that hangs (a startup file waiting on input, a
 * network-backed version manager) must never wedge the sidecar — the probe is
 * an optimization over `WELL_KNOWN_BIN_DIRS`, so giving up is always
 * survivable. Generous relative to the ~0.2-0.8s a real `zsh -lic` costs on a
 * loaded `.zshrc`.
 */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * `-l` (login) and `-i` (interactive) together are what make the shell read
 * *both* startup file sets — `.zprofile`/`.zshrc`, `.bash_profile`/`.bashrc`.
 * Version managers split their setup across the two inconsistently (mise's
 * `activate` typically lands in the interactive file, a raw `PATH=` export in
 * the login one), so probing with only one of them misses installs the user
 * can plainly see in their own terminal. `printenv PATH` rather than a shell
 * expansion of `$PATH` because fish stores `PATH` as a list, not a
 * colon-joined string — the environment variable is the one representation
 * every shell agrees on.
 */
const PROBE_SCRIPT = `printf %s '${DELIMITER}'; printenv PATH; printf %s '${DELIMITER}'`;

const between = (text: string): string | undefined => {
	const start = text.indexOf(DELIMITER);
	if (start === -1) return undefined;
	const end = text.indexOf(DELIMITER, start + DELIMITER.length);
	if (end === -1) return undefined;
	return text.slice(start + DELIMITER.length, end);
};

/**
 * The directories on the `PATH` the user's own login shell builds — the
 * general answer to "wherever this user's toolchain actually lives," in place
 * of an ever-growing list of hardcoded version-manager layouts — mise's
 * `shims` plus a per-tool `installs` tree, asdf's `shims`, nvm's and fnm's
 * per-version `bin` directories, volta's `bin`, each with its own versioned
 * nesting that a static list would have to keep guessing at. A macOS `.app`
 * launched from Finder/`open` inherits launchd's bare
 * `PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` and never runs a single
 * shell startup file, so this is the only way to see them.
 *
 * Returns an empty list rather than throwing on any failure — no `$SHELL`, a
 * shell that rejects the flags, a timeout, garbled output. Callers treat this
 * strictly as *extra* candidates appended after `PATH` and
 * `WELL_KNOWN_BIN_DIRS`, so an empty result just means resolution behaves
 * exactly as it did before this existed.
 */
export const probeLoginShellDirs = (): ReadonlyArray<string> => {
	const shell = process.env.SHELL;
	if (shell === undefined || shell.length === 0) return [];

	const stdout = ((): string | undefined => {
		try {
			return execFileSync(shell, ["-l", "-i", "-c", PROBE_SCRIPT], {
				encoding: "utf-8",
				timeout: PROBE_TIMEOUT_MS,
				// The probe's whole point is reading a *clean* environment's
				// startup files; stderr is rc-file noise (`zsh: can't change
				// option: zle` from a non-tty interactive shell, deprecation
				// warnings) that would otherwise leak into the sidecar's own
				// output while telling us nothing.
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			return undefined;
		}
	})();
	if (stdout === undefined) return [];

	const path = between(stdout);
	if (path === undefined) return [];
	return path
		.trim()
		.split(":")
		.filter((dir) => dir.length > 0);
};

/**
 * Memoizes `probe` for the process's lifetime with an explicit `refresh`
 * escape hatch — the same discover-once-then-refresh shape
 * `sidecar/walkthrough/model-discovery.ts`'s `createModelDiscoveryCache`
 * uses, and for the same reason: the probe is a subprocess whose answer is
 * stable while the app runs (a user's shell startup files don't change under
 * a running app), but a user who installs Node *while* nisi is open needs
 * some way to be seen without relaunching. `refresh` is what
 * `walkthrough.refreshHarnesses` calls.
 *
 * A factory rather than one module-level singleton so tests can exercise the
 * memoization against an isolated instance with a stub probe, instead of
 * paying for (and depending on the shape of) the developer's real shell —
 * `resolve-bin.ts` holds the one production instance.
 */
export const createLoginShellPathCache = (
	probe: () => ReadonlyArray<string> = probeLoginShellDirs,
) => {
	let dirs: ReadonlyArray<string> | undefined;

	/** The probed directories, running `probe` only on the first call. */
	const get = (): ReadonlyArray<string> => {
		const resolved = dirs ?? probe();
		dirs = resolved;
		return resolved;
	};

	/** Re-runs `probe` unconditionally and adopts its result as the new memo. */
	const refresh = (): ReadonlyArray<string> => {
		const resolved = probe();
		dirs = resolved;
		return resolved;
	};

	return { get, refresh };
};
