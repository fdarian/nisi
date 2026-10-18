import { Effect } from "effect";
import type { Shell } from "./shell.ts";

export type ProcessRow = { pid: number; ppid: number; command: string };

/** Parses `ps -axo pid=,ppid=,comm=`; `comm` is the full executable path, spaces included. */
export function parseProcessRows(output: string): ProcessRow[] {
	return output
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			if (match === null) throw new Error(`Invalid ps row: ${line}`);
			return {
				pid: Number(match[1]),
				ppid: Number(match[2]),
				command: match[3] as string,
			};
		});
}

const contentsPrefix = (shell: Shell) => `${shell.bundlePath}/Contents/`;

/** Every process whose executable lives inside the bundle. */
export function bundleRows(output: string, shell: Shell): ProcessRow[] {
	return parseProcessRows(output).filter((row) =>
		row.command.startsWith(contentsPrefix(shell)),
	);
}

/**
 * The bundle's processes plus every launchd-parented process macOS charges to
 * one of them (WebKit's XPC services, and system services spun up on the app's
 * behalf). The app's own subprocesses (the sidecar's git and gh) are charged to
 * it too but are work, not shell memory, and the bundle-prefix match never counted them.
 */
export function attributedRows(
	output: string,
	shell: Shell,
	responsibleOf: (pid: number) => number | undefined,
): ProcessRow[] {
	const table = parseProcessRows(output);
	const inBundle = bundleRows(output, shell);
	const appPids = new Set(inBundle.map((row) => row.pid));
	const parents = new Map(table.map((row) => [row.pid, row.ppid]));
	const descendsFromApp = (pid: number) => {
		for (
			let parent = parents.get(pid);
			parent !== undefined && parent > 1;
			parent = parents.get(parent)
		)
			if (appPids.has(parent)) return true;
		return false;
	};
	const charged = table.filter((row) => {
		if (appPids.has(row.pid) || descendsFromApp(row.pid)) return false;
		const responsible = responsibleOf(row.pid);
		return responsible !== undefined && appPids.has(responsible);
	});
	return [...inBundle, ...charged];
}

export function bundleProcessIds(output: string, shell: Shell): number[] {
	const executables = new Set(
		shell.stopExecutables.map((path) => `${shell.bundlePath}/${path}`),
	);
	return parseProcessRows(output)
		.filter((row) => executables.has(row.command))
		.map((row) => row.pid);
}

/** Bundle processes that are not in the stop list, e.g. CEF helpers. */
export function bundleHelperIds(output: string, shell: Shell): number[] {
	const stopped = new Set(bundleProcessIds(output, shell));
	return bundleRows(output, shell)
		.filter((row) => !stopped.has(row.pid))
		.map((row) => row.pid);
}

export const processTable = Effect.tryPromise(() =>
	Bun.$`ps -axo pid=,ppid=,comm=`.text(),
);

export const stopBundle = (shell: Shell) =>
	Effect.gen(function* () {
		const snapshot = yield* processTable;
		const pids = yield* Effect.try(() => bundleProcessIds(snapshot, shell));
		const unique = [...new Set(pids)];
		for (const pid of unique)
			yield* Effect.try({
				try: () => process.kill(pid, "SIGTERM"),
				catch: (error) => error,
			}).pipe(
				Effect.catch((error) =>
					typeof error === "object" &&
					error !== null &&
					"code" in error &&
					error.code === "ESRCH"
						? Effect.void
						: Effect.fail(error),
				),
			);
		const deadline = Date.now() + 10_000;
		while (unique.length > 0) {
			const output = yield* Effect.tryPromise(() => Bun.$`ps -axo pid=`.text());
			const live = new Set(output.trim().split(/\s+/).map(Number));
			if (unique.every((pid) => !live.has(pid))) break;
			if (Date.now() >= deadline)
				return yield* Effect.fail(
					new Error(
						"Worktree app or sidecar did not exit after SIGTERM; refusing cold measurement",
					),
				);
			yield* Effect.sleep("100 millis");
		}
		if (!shell.waitForHelpers) return;
		while (true) {
			const remaining = yield* processTable.pipe(
				Effect.flatMap((output) =>
					Effect.try(() => bundleHelperIds(output, shell)),
				),
			);
			if (remaining.length === 0) return;
			if (Date.now() >= deadline)
				return yield* Effect.fail(
					new Error(
						`Helper processes of ${shell.bundlePath} did not exit after SIGTERM (${remaining.join(", ")}); refusing cold measurement`,
					),
				);
			yield* Effect.sleep("100 millis");
		}
	});
