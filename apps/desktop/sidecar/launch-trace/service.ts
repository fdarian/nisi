import { getDataDirConfig } from "@repo/db";
import { Context, Effect, Layer } from "effect";
import { appendLaunchMarks, type LaunchMark } from "./file-writer.ts";

const boot: LaunchMark[] = [
	{
		at: performance.timeOrigin,
		source: "sidecar",
		name: "sidecar.process-start",
	},
];
type ActiveTrace = { id: string; dataDir: string; deadline: number };
const state: { active?: ActiveTrace } = {};

export function bufferBootMark(name: string): void {
	boot.push({ at: Date.now(), source: "sidecar", name });
}

export function activeTrace(): ActiveTrace | undefined {
	if (state.active !== undefined && Date.now() >= state.active.deadline)
		state.active = undefined;
	return state.active;
}

export function writeSidecarMark(
	name: string,
	attrs: Record<string, unknown> = {},
	trace = activeTrace(),
): void {
	if (trace === undefined || activeTrace()?.id !== trace.id) return;
	appendLaunchMarks(trace.dataDir, trace.id, [
		{ at: Date.now(), ...attrs, source: "sidecar", name },
	]);
}

export class LaunchTrace extends Context.Service<LaunchTrace>()(
	"sidecar/LaunchTrace",
	{
		make: Effect.gen(function* () {
			const dataDir = yield* getDataDirConfig();
			return {
				activate: (id: string | undefined) =>
					Effect.try(() => {
						if (id === undefined) return;
						const current = activeTrace();
						if (current?.id === id) return;
						appendLaunchMarks(dataDir, id, boot);
						state.active = { id, dataDir, deadline: Date.now() + 60_000 };
					}).pipe(Effect.orDie),
				frontend: (
					id: string,
					marks: readonly { at: number; name: string; tab?: string }[],
				) =>
					Effect.try(() => {
						const trace = activeTrace();
						if (trace?.id !== id) return;
						appendLaunchMarks(
							dataDir,
							id,
							marks.map((mark) => ({ ...mark, source: "frontend" as const })),
						);
						if (marks.some((mark) => mark.name === "trace.done"))
							state.active = undefined;
					}).pipe(Effect.orDie),
			};
		}),
	},
) {
	static readonly layer = Layer.effect(LaunchTrace, LaunchTrace.make);
}
