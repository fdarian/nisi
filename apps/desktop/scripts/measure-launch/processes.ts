import { Effect } from "effect";

export function bundleProcessIds(output: string, bundle: string): number[] {
	const processes = output
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
			if (match === null) throw new Error(`Invalid ps row: ${line}`);
			return {
				pid: Number(match[1]),
				command: match[3],
			};
		});
	return processes
		.filter(
			(entry) =>
				entry.command === `${bundle}/Contents/MacOS/nisi` ||
				entry.command === `${bundle}/Contents/MacOS/sidecar`,
		)
		.map((entry) => entry.pid);
}

export const stopBundle = (bundle: string) =>
	Effect.gen(function* () {
		const snapshot = yield* Effect.tryPromise(() =>
			Bun.$`ps -axo pid=,ppid=,comm=`.text(),
		);
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
