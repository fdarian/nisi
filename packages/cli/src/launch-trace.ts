import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, Effect, Option } from "effect";

const state: { trace?: { id: string; directory: string } } = {};
export const launchTraceId = () => state.trace?.id;

export function cliMark(
	name: string,
	attrs: Record<string, unknown> = {},
	at?: number,
): void {
	const trace = state.trace;
	if (trace === undefined) return;
	appendFileSync(
		join(trace.directory, `${trace.id}.jsonl`),
		`${JSON.stringify({ ...attrs, at: at === undefined ? Date.now() : at, source: "cli", name })}\n`,
	);
}

export const initializeLaunchTrace = Effect.gen(function* () {
	const id = Option.getOrUndefined(
		yield* Config.string("NISI_LAUNCH_TRACE").pipe(Config.option),
	);
	if (id === undefined) return;
	if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
		return yield* Effect.die(new Error("Invalid launch trace ID"));
	const dataDir = yield* Config.string("NISI_DATA_DIR").pipe(
		Config.withDefault(
			join(homedir(), "Library", "Application Support", "com.nisi.desktop"),
		),
	);
	yield* Effect.try(() => {
		const directory = join(dataDir, "logs", "launch-traces");
		mkdirSync(directory, { recursive: true });
		state.trace = { id, directory };
		cliMark("cli.process-start", {}, performance.timeOrigin);
		cliMark("cli.main");
	}).pipe(Effect.orDie);
});
