import path from "node:path";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { ChildProcess } from "effect/unstable/process";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run a command with its stdio inherited, resolving with its exit code. */
function run(command: string, args: ReadonlyArray<string>) {
	return Effect.gen(function* () {
		const handle = yield* ChildProcess.make(command, args, {
			cwd: appDir,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		return yield* handle.exitCode;
	});
}

/**
 * Dev orchestrator: starts the sidecar and `tauri dev` (which itself runs
 * `vite` via `beforeDevCommand` in tauri.conf.json) side by side. `raceAll`
 * — not `Effect.all` — means whichever exits first ends the race,
 * interrupting (and, via the process Command's scope, killing) the other.
 * Rheya uses `devsess` here for per-worktree data-dir/port isolation; nisi
 * doesn't need that yet, so this is the plain two-process version.
 */
const program = Effect.scoped(
	Effect.raceAll([
		run("bun", ["run", "sidecar/index.ts"]),
		run("bunx", ["tauri", "dev"]),
	]),
);

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
