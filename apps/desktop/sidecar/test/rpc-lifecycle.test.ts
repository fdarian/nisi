import { expect, spyOn, test } from "bun:test";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Context, Effect, Option, Tracer } from "effect";
import { RpcLifecyclePlugin } from "../rpc-lifecycle.ts";

test("logs completed RPCs through the shared handler plugin", async () => {
	const entries: { message: string; fields: Record<string, unknown> }[] = [];
	const plugin = new RpcLifecyclePlugin(async (message, fields) => {
		entries.push({ message, fields });
	}, Effect.runPromise);
	const handler = new RPCHandler(
		{ ping: os.handler(() => "pong") },
		{
			plugins: [plugin],
		},
	);
	const result = await handler.handle(
		new Request("http://localhost/api/ping", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: null }),
		}),
		{ prefix: "/api" },
	);
	expect(result.matched).toBe(true);
	expect(entries.map((entry) => entry.message)).toEqual([
		"rpc call started",
		"rpc call finished",
	]);
	expect(entries[1]?.fields).toMatchObject({
		path: "/api/ping",
		matched: true,
		status: 200,
	});
});

test("RPC lifecycle no longer computes debug durations", async () => {
	const clock = { at: 1000 };
	const now = spyOn(Date, "now").mockImplementation(() => clock.at);
	const entries: Record<string, unknown>[] = [];
	const handler = new RPCHandler(
		{
			ping: os.handler(() => {
				clock.at += 25;
				return "pong";
			}),
		},
		{
			plugins: [
				new RpcLifecyclePlugin(async (_, fields) => {
					entries.push(fields);
				}, Effect.runPromise),
			],
		},
	);
	try {
		await handler.handle(
			new Request("http://localhost/api/ping", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ json: null }),
			}),
			{ prefix: "/api" },
		);
		expect(entries[1]?.durationMs).toBeUndefined();
	} finally {
		now.mockRestore();
	}
});

test("RPC span is the parent of handler operation spans", async () => {
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
	const run = <A>(effect: Effect.Effect<A>) =>
		Effect.runPromise(effect.pipe(Effect.withTracer(tracer)));
	const procedure = os
		.$context<{ effect: Context.Context<Tracer.ParentSpan> }>()
		.handler((call) =>
			Effect.runPromise(
				Effect.void.pipe(
					Effect.withSpan("handler-operation"),
					Effect.provide(call.context.effect),
					Effect.withTracer(tracer),
				),
			),
		);
	const plugin = new RpcLifecyclePlugin<{
		effect: Context.Context<Tracer.ParentSpan>;
	}>(
		async () => {},
		run,
		(context, span) => ({
			effect: Context.add(context.effect, Tracer.ParentSpan, span),
		}),
	);
	const handler = new RPCHandler({ ping: procedure }, { plugins: [plugin] });
	await handler.handle(
		new Request("http://localhost/api/ping", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: null }),
		}),
		{
			prefix: "/api",
			context: {
				effect: Context.make(
					Tracer.ParentSpan,
					Tracer.externalSpan({
						spanId: "incoming",
						traceId: "incoming-trace",
					}),
				),
			},
		},
	);
	expect(spans.map((span) => span.name)).toEqual(["rpc", "handler-operation"]);
	const child = spans[1];
	if (child === undefined) throw new Error("Missing handler span");
	expect(Option.getOrUndefined(child.parent)?.spanId).toBe(spans[0]?.spanId);
	expect(spans.every((span) => span.status._tag === "Ended")).toBe(true);
});
