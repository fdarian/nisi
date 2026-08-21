import { checkBinAvailability, resolveBin } from "@repo/bin-resolver";
import { Effect, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CASK_TOKEN } from "./constants.ts";

/**
 * Resolved once per process, same reasoning as `packages/git/src/exec.ts`'s
 * `GIT_BIN`/`GH_BIN`: a GUI-launched `.app` doesn't have `/opt/homebrew/bin`
 * on `PATH` (no login shell startup files ever run), so a bare `"brew"`
 * would silently fail to spawn in the built app even though it resolves fine
 * from a terminal.
 */
export const BREW_BIN = resolveBin("brew", "NISI_BREW_BIN");

type BrewResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

/**
 * Runs `brew <args>` to completion, reporting its exit code rather than
 * failing on a nonzero one — every caller here treats "brew ran and said
 * no" (not a cask install, an upgrade that found nothing to do) as an
 * expected outcome to branch on, not an error. A genuine failure to spawn at
 * all (`PlatformError` — ENOENT despite `resolveBin` having found it on disk
 * moments earlier, a permissions problem, ...) is different from that, and
 * is left in the error channel for each caller to decide how to treat.
 *
 * `HOMEBREW_NO_AUTO_UPDATE=1` on every invocation, not just the restart
 * script's `upgrade` — a `brew list`/`brew fetch` that silently pays for
 * brew's own tap-index refresh would make even a version *check* slow.
 */
const runBrew = (
	args: ReadonlyArray<string>,
): Effect.Effect<
	BrewResult,
	PlatformError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			yield* Effect.logDebug("spawning brew", { args });
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const handle = yield* spawner.spawn(
				ChildProcess.make(BREW_BIN, args, {
					env: { HOMEBREW_NO_AUTO_UPDATE: "1" },
					extendEnv: true,
				}),
			);
			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.decodeText(handle.stdout).pipe(Stream.mkString),
					Stream.decodeText(handle.stderr).pipe(Stream.mkString),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			);
			yield* Effect.logDebug("brew exited", { args, exitCode });
			return { stdout, stderr, exitCode };
		}),
	);

/**
 * Parses `brew list --cask --versions <token>`'s stdout — one line, e.g.
 * `nisi 0.2.3`. A cask with more than one version installed (rare — Homebrew
 * normally keeps just the current one) would list further tokens after the
 * first; only the first is read, since that's what a fresh `brew list`
 * reports as "the" installed version in every observed case.
 */
export const parseCaskListVersion = (
	stdout: string,
	token: string,
): string | undefined => {
	const line = stdout.split("\n").find((entry) => entry.trim().length > 0);
	if (line === undefined) return undefined;
	const [name, version] = line.trim().split(/\s+/);
	return name === token ? version : undefined;
};

/**
 * Whether this install came from the `nisi` Homebrew cask, and if so, which
 * version — `"not-installed"` covers both "`brew` isn't on this machine" and
 * "`brew list --cask --versions nisi` exited nonzero" (verified: that exit
 * code *is* the detection check, not installed via cask otherwise), which is
 * the trigger for `UpdateState`'s terminal `unsupported`.
 * `"check-failed"` is different and deliberately not folded into
 * `"not-installed"`: it means `brew` exists on disk but the spawn itself
 * failed (a `PlatformError`, not a nonzero exit) — a transient host hiccup
 * that shouldn't permanently disable update checks for the rest of the
 * process's life the way `"not-installed"` does. The caller (`updater/service.ts`'s
 * background check) retries on the next tick instead.
 */
export type CaskProbe =
	| { readonly kind: "not-installed" }
	| { readonly kind: "installed"; readonly version: string }
	| { readonly kind: "check-failed" };

const probeCaskInstall = (): Effect.Effect<
	CaskProbe,
	PlatformError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		if (!checkBinAvailability("brew", "NISI_BREW_BIN").available) {
			return { kind: "not-installed" };
		}

		const result = yield* runBrew(["list", "--cask", "--versions", CASK_TOKEN]);
		if (result.exitCode !== 0) return { kind: "not-installed" };

		const version = parseCaskListVersion(result.stdout, CASK_TOKEN);
		return version === undefined
			? { kind: "not-installed" }
			: { kind: "installed", version };
	});

export const detectCaskInstall: Effect.Effect<
	CaskProbe,
	never,
	ChildProcessSpawner.ChildProcessSpawner
> = probeCaskInstall().pipe(
	Effect.catchTag("PlatformError", (cause) =>
		Effect.succeed<CaskProbe>({ kind: "check-failed" }).pipe(
			Effect.tap(() =>
				Effect.logWarning(
					"could not run brew to check the cask install — will retry on the next check",
					{ reason: cause.message },
				),
			),
		),
	),
);

/**
 * `brew fetch --cask nisi` — downloads the DMG into `$(brew --cache)`
 * without installing anything, so a later `brew upgrade` (run by the
 * restart helper, after this app has quit) reuses the cached file instead
 * of downloading again.
 */
export const fetchCaskArtifact: Effect.Effect<
	BrewResult,
	PlatformError,
	ChildProcessSpawner.ChildProcessSpawner
> = runBrew(["fetch", "--cask", CASK_TOKEN]);
