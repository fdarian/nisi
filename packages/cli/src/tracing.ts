import { getDataDirConfig } from "@repo/db/paths";
import { makeLaunchTracer } from "@repo/logging";
import { Config, Effect, Layer, Option, Tracer } from "effect";

export const LaunchTracingLive = Layer.unwrap(
	Effect.gen(function* () {
		const dataDir = yield* getDataDirConfig();
		const exporter = yield* makeLaunchTracer({ dataDir, source: "cli" });
		const id = Option.getOrUndefined(
			yield* Config.string("NISI_LAUNCH_TRACE").pipe(Config.option),
		);
		yield* exporter.activate(id);
		if (id !== undefined)
			yield* exporter.append(id, [
				{
					type: "mark",
					at: performance.timeOrigin,
					source: "cli",
					name: "cli.process-start",
					attrs: {},
				},
			]);
		return Layer.succeed(Tracer.Tracer, exporter.tracer);
	}),
);
