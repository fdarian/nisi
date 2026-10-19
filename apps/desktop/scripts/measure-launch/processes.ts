import { Effect } from "effect";

export type ProcessRow = { pid: number; command: string };

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
				command: match[3] as string,
			};
		});
}

/** Every process whose executable lives inside the bundle. */
export function bundleRows(output: string, bundle: string): ProcessRow[] {
	return parseProcessRows(output).filter((row) =>
		row.command.startsWith(`${bundle}/Contents/`),
	);
}

export function bundleProcessIds(output: string, bundle: string): number[] {
	return parseProcessRows(output)
		.filter(
			(row) =>
				row.command === `${bundle}/Contents/MacOS/nisi` ||
				row.command === `${bundle}/Contents/MacOS/sidecar`,
		)
		.map((row) => row.pid);
}

export const processTable = Effect.tryPromise(() =>
	Bun.$`ps -axo pid=,ppid=,comm=`.text(),
);

export const stopBundle = (bundle: string) =>
	Effect.gen(function* () {
		const snapshot = yield* processTable;
		const pids = yield* Effect.try(() => bundleProcessIds(snapshot, bundle));
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
			if (unique.every((pid) => !live.has(pid))) return;
			if (Date.now() >= deadline)
				return yield* Effect.fail(
					new Error(
						"Worktree app or sidecar did not exit after SIGTERM; refusing cold measurement",
					),
				);
			yield* Effect.sleep("100 millis");
		}
	});
