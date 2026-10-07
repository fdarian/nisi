import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { LaunchRecord } from "../src/launch-record.ts";

test("shared schema decodes span and frontend event records", () => {
	const decode = Schema.decodeUnknownEffect(LaunchRecord);
	expect(
		Effect.runSync(
			decode({
				type: "span",
				source: "sidecar",
				name: "subprocess",
				start: 1,
				end: 2,
				spanId: "child",
				parentSpanId: "parent",
				attrs: { command: "git", exitCode: 0 },
			}),
		),
	).toMatchObject({
		type: "span",
		parentSpanId: "parent",
		attrs: { exitCode: 0 },
	});
	expect(
		Effect.runSync(
			decode({
				type: "mark",
				source: "frontend",
				name: "frontend.visibility",
				at: 3,
				attrs: { hidden: true },
			}),
		),
	).toMatchObject({ type: "mark", attrs: { hidden: true } });
});

test("shared schema rejects legacy marks and incomplete spans", () => {
	const decode = Schema.decodeUnknownEffect(LaunchRecord);
	expect(
		Effect.runSync(
			decode({
				source: "frontend",
				name: "frontend.visibility",
				at: 3,
				hidden: true,
			}).pipe(Effect.isFailure),
		),
	).toBe(true);
	expect(
		Effect.runSync(
			decode({
				type: "span",
				source: "sidecar",
				name: "subprocess",
				start: 1,
				spanId: "child",
				attrs: {},
			}).pipe(Effect.isFailure),
		),
	).toBe(true);
});
