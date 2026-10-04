import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer } from "effect";
import {
	type ChildProcess,
	ChildProcessSpawner,
} from "effect/unstable/process";
import { activeTrace, writeSidecarMark } from "./service.ts";

function commands(
	command: ChildProcess.Command,
): { command: string; args: string[] }[] {
	if (command._tag === "PipedCommand")
		return [...commands(command.left), ...commands(command.right)];
	return [
		{
			command: command.command,
			args: command.args.map((arg) =>
				arg.length > 256 ? `${arg.slice(0, 256)}…` : arg,
			),
		},
	];
}

export const decorateSpawner = (
	original: ReturnType<typeof ChildProcessSpawner.make>,
) =>
	ChildProcessSpawner.make((command) =>
		Effect.gen(function* () {
			const trace = activeTrace();
			if (trace === undefined) return yield* original.spawn(command);
			const at = Date.now();
			const captured = commands(command);
			yield* writeSidecarMark(
				"spawn.start",
				{
					at,
					command: captured.map((entry) => entry.command).join(" | "),
					args: captured.flatMap((entry) => entry.args),
				},
				trace,
			);
			const scope = yield* Effect.scope;
			const result = yield* original.spawn(command).pipe(Effect.exit);
			if (Exit.isFailure(result)) {
				yield* writeSidecarMark(
					"spawn",
					{
						at,
						command: captured.map((entry) => entry.command).join(" | "),
						args: captured.flatMap((entry) => entry.args),
						durationMs: Date.now() - at,
						outcome: "spawn-failed",
						error: Cause.pretty(result.cause),
					},
					trace,
				);
				return yield* Effect.failCause(result.cause);
			}
			const handle = result.value;
			const observation = { recorded: false };
			const exitCode = handle.exitCode.pipe(
				Effect.onExit((exit) =>
					Effect.gen(function* () {
						if (observation.recorded) return;
						observation.recorded = true;
						yield* writeSidecarMark(
							"spawn",
							{
								at,
								command: captured.map((entry) => entry.command).join(" | "),
								args: captured.flatMap((entry) => entry.args),
								durationMs: Date.now() - at,
								...(Exit.isSuccess(exit)
									? { exitCode: Number(exit.value) }
									: {
											outcome: Cause.hasInterruptsOnly(exit.cause)
												? "scope-closed"
												: "exit-failed",
											error: Cause.pretty(exit.cause),
										}),
							},
							trace,
						);
					}),
				),
			);
			// Callers may close the spawn scope immediately after awaiting exitCode;
			// observing that same effect guarantees the mark precedes scope teardown.
			yield* Effect.forkIn(exitCode.pipe(Effect.exit), scope);
			return { ...handle, exitCode };
		}),
	);

export const TracedBunServices = Layer.effect(
	ChildProcessSpawner.ChildProcessSpawner,
)(
	Effect.gen(function* () {
		return decorateSpawner(yield* ChildProcessSpawner.ChildProcessSpawner);
	}),
).pipe(Layer.provideMerge(BunServices.layer));
