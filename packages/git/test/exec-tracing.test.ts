import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Option, Tracer } from "effect";
import { runBytes, runText } from "../src/exec.ts";

test("text and byte subprocess spans inherit operation parents and record exit codes", async () => {
	const native = Effect.runSync(Effect.tracer);
	const spans: Tracer.Span[] = [];
	const tracer = Tracer.make({
		span(options) {
			const span = native.span(options);
			spans.push(span);
			return span;
		},
		context: native.context,
	});
	await Effect.runPromise(
		Effect.gen(function* () {
			yield* runText(process.cwd(), process.execPath, [
				"-e",
				"process.stdout.write('text')",
			]);
			yield* runBytes(process.cwd(), process.execPath, [
				"-e",
				"process.exit(7)",
			]).pipe(Effect.flip);
		}).pipe(
			Effect.withSpan("operation"),
			Effect.withTracer(tracer),
			Effect.provide(BunServices.layer),
		),
	);
	const parent = spans.find((span) => span.name === "operation");
	const children = spans.filter((span) => span.name === "subprocess");
	expect(children).toHaveLength(2);
	expect(
		children.map((span) => Option.getOrUndefined(span.parent)?.spanId),
	).toEqual([parent?.spanId, parent?.spanId]);
	expect(children.map((span) => span.attributes.get("exitCode"))).toEqual([
		0, 7,
	]);
	expect(children.every((span) => span.status._tag === "Ended")).toBe(true);
});
