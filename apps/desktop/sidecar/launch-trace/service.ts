import { getDataDirConfig } from "@repo/db";
import { makeLaunchTracer } from "@repo/logging";
import type { LaunchMark } from "@repo/sidecar-api";
import { Context, Effect, Layer, Tracer } from "effect";

export class LaunchTrace extends Context.Service<LaunchTrace>()(
	"sidecar/LaunchTrace",
	{
		make: Effect.gen(function* () {
			const dataDir = yield* getDataDirConfig();
			const exporter = yield* makeLaunchTracer({ dataDir, source: "sidecar" });
			return {
				exporter,
				activate: exporter.activate,
				frontend: (id: string, marks: readonly LaunchMark[]) =>
					Effect.gen(function* () {
						if (exporter.activeId() !== id) return;
						yield* exporter.append(
							id,
							marks.map((mark) => ({ ...mark, source: "frontend" as const })),
						);
						if (marks.some((mark) => mark.name === "trace.done"))
							yield* exporter.deactivate();
					}),
			};
		}),
	},
) {
	static readonly layer = Layer.effect(LaunchTrace, LaunchTrace.make);
	static readonly tracingLayer = Layer.effect(
		Tracer.Tracer,
		Effect.map(LaunchTrace, (trace) => trace.exporter.tracer),
	).pipe(Layer.provideMerge(LaunchTrace.layer));
}
