import { join } from "node:path";
import { getDataDirConfig } from "@repo/db";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { CASK_TOKEN } from "./constants.ts";
import { restartOutcomePathFor } from "./restart-outcome.ts";

/**
 * The app can't upgrade its own bundle while running, so the upgrade has to
 * happen in the gap between quit and relaunch — this script is that gap.
 * POSIX `sh`, not bash (macOS ships `/bin/sh`, nothing more is assumed).
 * Every input arrives as `$1..$5`, never baked into the script text itself:
 * `ChildProcess.make` hands argv straight to `execve`, no shell
 * interpolation involved, so there's nothing here to quote.
 *
 * Everything after the `exec >>` redirect logs to `$4` instead of a
 * terminal — by the time most of this runs, both the app and the sidecar
 * that wrote it are gone, so there's nobody to print to.
 */
const RESTART_SCRIPT = `#!/bin/sh
set -u

brew_path="$1"
app_pid="$2"
app_path="$3"
log_path="$4"
outcome_path="$5"

exec >> "$log_path" 2>&1
echo "[$(date)] restart helper started -- brew=$brew_path pid=$app_pid app=$app_path"

# Wait for the app to actually quit, bounded so a stuck app can't strand this
# helper forever. The cask has no "uninstall quit:" stanza, so nothing else
# stops "brew upgrade" from overwriting the bundle under a still-running app
# -- this wait is what keeps that from happening on the in-app restart path.
# If the app is already gone by the time this runs, "kill -0" fails on the
# very first check and the loop falls through immediately.
waited=0
while kill -0 "$app_pid" 2>/dev/null; do
  if [ "$waited" -ge 60 ]; then
    echo "[$(date)] timed out after 60s waiting for pid $app_pid to exit -- proceeding anyway"
    break
  fi
  sleep 1
  waited=$((waited + 1))
done

version_before=$("$brew_path" list --cask --versions ${CASK_TOKEN} 2>/dev/null | awk '{print $2}')
echo "[$(date)] installed version before upgrade: \${version_before:-unknown}"

# Explicit refresh, same reasoning as homebrew.ts's refreshTap: every brew
# invocation here (including "upgrade" below) sets HOMEBREW_NO_AUTO_UPDATE=1,
# which suppresses the only thing that ever refreshes the local clone of a
# third-party tap like fdarian/homebrew-tap. Without this, "brew upgrade"
# reads a frozen cask and exits 0 having upgraded nothing.
echo "[$(date)] running: HOMEBREW_NO_AUTO_UPDATE=1 $brew_path update"
HOMEBREW_NO_AUTO_UPDATE=1 "$brew_path" update
update_status=$?
echo "[$(date)] brew update exited with status $update_status"

echo "[$(date)] running: HOMEBREW_NO_AUTO_UPDATE=1 $brew_path upgrade --cask ${CASK_TOKEN}"
HOMEBREW_NO_AUTO_UPDATE=1 "$brew_path" upgrade --cask ${CASK_TOKEN}
upgrade_status=$?
echo "[$(date)] brew upgrade exited with status $upgrade_status"

version_after=$("$brew_path" list --cask --versions ${CASK_TOKEN} 2>/dev/null | awk '{print $2}')
echo "[$(date)] installed version after upgrade: \${version_after:-unknown}"

# Recorded so the sidecar can reconcile this attempt on its next boot (see
# restart-outcome.ts) -- this script's own stdout/stderr lands in
# restart.log, which nothing ever reads back on its own.
printf '{"versionBefore":"%s","versionAfter":"%s","exitCode":%s}' \\
  "\${version_before:-unknown}" "\${version_after:-unknown}" "$upgrade_status" > "$outcome_path"
echo "[$(date)] wrote upgrade outcome to $outcome_path"

# Relaunch unconditionally, whether or not the upgrade above succeeded -- a
# failed upgrade must leave the user with a working old app, not nothing.
# The next background check re-offers the update.
echo "[$(date)] relaunching: open -a $app_path"
open -a "$app_path"
open_status=$?
echo "[$(date)] open exited with status $open_status"
`;

export type RestartHelperParams = {
	readonly brewPath: string;
	readonly appPath: string;
	/**
	 * The sidecar's own `process.ppid` — Tauri's shell plugin spawns the
	 * sidecar as a direct child of the app, so the app's pid is always the
	 * sidecar's parent. Logged by the caller (`updater/service.ts`) so this
	 * assumption is debuggable if it ever stops holding.
	 */
	readonly appPid: number;
};

/**
 * Writes the restart script to `<data dir>/update/restart.sh` and spawns it
 * fully detached: its own process group (`detached: true`) with every stdio
 * stream ignored (nothing's left alive to read them), then `handle.unref`
 * before this function's scope closes. That last step matters more than it
 * looks — `NodeChildProcessSpawner`'s scope-release finalizer kills a
 * still-running child by default when its scope ends, *unless* the handle
 * was unrefed first (checked via the very `isReferenced` flag `unref` sets).
 * Skipping it would mean the helper dies the instant this RPC call returns,
 * defeating the entire "survive the sidecar exiting" point of spawning it in
 * the first place.
 */
export const spawnRestartHelper = (params: RestartHelperParams) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* getDataDirConfig();
		const updateDir = join(dataDir, "update");
		yield* fs.makeDirectory(updateDir, { recursive: true });

		const scriptPath = join(updateDir, "restart.sh");
		const logPath = join(updateDir, "restart.log");
		const outcomePath = restartOutcomePathFor(dataDir);
		yield* fs.writeFileString(scriptPath, RESTART_SCRIPT, { mode: 0o755 });

		yield* Effect.logInfo("spawning detached restart helper", {
			scriptPath,
			appPid: params.appPid,
			appPath: params.appPath,
			logPath,
			outcomePath,
		});

		yield* Effect.scoped(
			Effect.gen(function* () {
				const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
				const handle = yield* spawner.spawn(
					ChildProcess.make(
						"/bin/sh",
						[
							scriptPath,
							params.brewPath,
							String(params.appPid),
							params.appPath,
							logPath,
							outcomePath,
						],
						{
							detached: true,
							stdin: "ignore",
							stdout: "ignore",
							stderr: "ignore",
						},
					),
				);
				yield* handle.unref;
			}),
		);
	});
