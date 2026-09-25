import { expect, test } from "bun:test";
import { Context, Effect, Stream } from "effect";
import { streamToIterator } from "../stream-bridge.ts";

test("bridges values and preserves a terminal typed error", async () => {
	const failure = new Error("authentication required");
	const stream = Stream.concat(Stream.succeed("current"), Stream.fail(failure));
	const received: string[] = [];
	await expect(
		(async () => {
			for await (const value of streamToIterator(stream, Context.empty())) {
				received.push(value);
			}
		})(),
	).rejects.toBe(failure);
	expect(received).toEqual(["current"]);
});

test("releases the stream when the consumer leaves", async () => {
	let released = false;
	const stream = Stream.unwrap(
		Effect.acquireRelease(Effect.succeed(Stream.succeed("current")), () =>
			Effect.sync(() => {
				released = true;
			}),
		),
	);
	for await (const _value of streamToIterator(stream, Context.empty())) {
		break;
	}
	expect(released).toBe(true);
});
