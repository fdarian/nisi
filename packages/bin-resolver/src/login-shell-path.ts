import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A login+interactive shell that hangs (a startup file waiting on input, a
 * network-backed version manager) must never wedge the sidecar — the probe is
 * an optimization over `WELL_KNOWN_BIN_DIRS`, so giving up is always
 * survivable. Generous relative to the ~0.2-0.8s a real `zsh -lic` costs on a
 * loaded `.zshrc`.
 *
 * The timeout is only enforceable because the probe uses `SIGKILL` and no
 * stdio pipes: `zsh -i` ignores `SIGTERM` while a foreground child runs, and a
 * grandchild started by an rc file (a slow `sleep`, a network call) inherits
 * a captured stdout and keeps it open, so `execFileSync` would wait on the
 * pipe long after the shell was killed. The answer comes back through a file
 * instead.
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
const probeScript = (outFile: string): string => `printenv PATH > '${outFile}'`;

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
export const probeLoginShellDirs = (
	timeoutMs: number = PROBE_TIMEOUT_MS,
): ReadonlyArray<string> => {
	const shell = process.env.SHELL;
	if (shell === undefined || shell.length === 0) return [];

	let dir: string | undefined;
	try {
		dir = mkdtempSync(join(tmpdir(), "nisi-login-path-"));
		const outFile = join(dir, "path");
		// stdio is fully ignored: stdout/stderr would be rc-file chatter anyway,
		// and any open pipe can be held by an rc grandchild (see
		// `PROBE_TIMEOUT_MS`). Throws on a non-zero exit or a timeout.
		execFileSync(shell, ["-l", "-i", "-c", probeScript(outFile)], {
			timeout: timeoutMs,
			killSignal: "SIGKILL",
			stdio: "ignore",
		});
		return readFileSync(outFile, "utf-8")
			.trim()
			.split(":")
			.filter((entry) => entry.length > 0);
	} catch {
		return [];
	} finally {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
};

/**
 * Memoizes `probe` for the process's lifetime with an explicit `refresh`
 * escape hatch — the same discover-once-then-refresh shape
 * `sidecar/harness/model-discovery.ts`'s `createModelDiscoveryCache`
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
