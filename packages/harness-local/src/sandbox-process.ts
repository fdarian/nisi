import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";
import type { Experimental_SandboxProcess } from "@ai-sdk/provider-utils";

/**
 * Wraps a real `child_process` handle as the `Experimental_SandboxProcess`
 * shape `spawn()` must return: streamed stdout/stderr, an awaitable exit,
 * and `kill()`. Shared by `run()` (which drains it synchronously) and
 * `spawn()` (which hands it back live).
 */
export function toSandboxProcess(
	child: ChildProcess,
	abortSignal: AbortSignal | undefined,
): Experimental_SandboxProcess {
	if (child.stdout == null || child.stderr == null) {
		throw new Error(
			"Spawned process is missing stdout/stderr pipes — it was not spawned with stdio: 'pipe'.",
		);
	}

	const exited = new Promise<{ exitCode: number }>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", (code, signal) => {
			resolve({ exitCode: resolveExitCode(code, signal) });
		});
	});

	return {
		pid: child.pid,
		stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
		stderr: Readable.toWeb(child.stderr) as ReadableStream<Uint8Array>,
		async wait() {
			const result = await exited;
			if (abortSignal?.aborted) {
				throw abortSignal.reason ?? new DOMException("Aborted", "AbortError");
			}
			return result;
		},
		async kill() {
			child.kill("SIGTERM");
		},
	};
}

/**
 * A process killed by a signal has no traditional exit code; `128 + signum`
 * is the real value the shell itself reports as `$?` in that case (not a
 * placeholder). Node only omits both `code` and `signal` on `'close'` when
 * the process never started, which `child.on('error', ...)` above already
 * catches — so reaching neither here means something violated that contract.
 */
function resolveExitCode(
	code: number | null,
	signal: NodeJS.Signals | null,
): number {
	if (code !== null) return code;
	if (signal !== null) return 128 + osConstants.signals[signal];
	throw new Error(
		"Process 'close' event reported neither an exit code nor a signal.",
	);
}
