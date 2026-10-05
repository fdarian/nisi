import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { launchTracePath } from "@repo/logging";
import { contract, LaunchRecord, makeSidecarClient } from "@repo/sidecar-api";
import { ConfigProvider, Effect, Schema } from "effect";
import { RpcLifecyclePlugin } from "../rpc-lifecycle.ts";
import { receiveFrontendMarks } from "./handler.ts";
import { LaunchTrace } from "./service.ts";

test("diagnostics RPC validates and appends frontend marks to the active trace", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nisi-diagnostics-rpc-"));
	try {
		await Effect.runPromise(
			Effect.gen(function* () {
				const context = yield* Effect.context<LaunchTrace>();
				const trace = yield* LaunchTrace;
				yield* trace.activate("active");
				const diagnostics =
					implement(contract).$context<WithEffectContext<LaunchTrace>>()
						.diagnostics;
				const router = {
					launchMarks: diagnostics.launchMarks.effect(receiveFrontendMarks),
				};
				const run = <A>(effect: Effect.Effect<A>) =>
					Effect.runPromise(Effect.provide(effect, context));
				const handler = new RPCHandler(
					{ diagnostics: router },
					{ plugins: [new RpcLifecyclePlugin(async () => {}, run)] },
				);
				const server = yield* Effect.acquireRelease(
					Effect.sync(() =>
						Bun.serve({
							port: 0,
							async fetch(request) {
								const result = await handler.handle(request, {
									prefix: "/api",
									context: { "effect/context": context },
								});
								return result.matched
									? result.response
									: new Response("not found", { status: 404 });
							},
						}),
					),
					(server) => Effect.sync(() => server.stop(true)),
				);
				if (server.port === undefined)
					return yield* Effect.die(new Error("HTTP test server has no port"));
				const client = makeSidecarClient({
					port: server.port,
					token: "test-token",
				});
				yield* Effect.tryPromise(() =>
					client.diagnostics.launchMarks({
						traceId: "active",
						marks: [
							{
								type: "mark",
								source: "frontend",
								name: "frontend.visibility",
								at: 100,
								attrs: { hidden: true },
							},
						],
					}),
				);
				const text = yield* Effect.tryPromise(() =>
					Bun.file(launchTracePath(dir, "active")).text(),
				);
				const records = yield* Effect.forEach(text.trim().split("\n"), (line) =>
					Schema.decodeUnknownEffect(Schema.fromJsonString(LaunchRecord))(line),
				);
				expect(records).toContainEqual({
					type: "mark",
					source: "frontend",
					name: "frontend.visibility",
					at: 100,
					attrs: { hidden: true },
				});
				expect(
					records.some(
						(record) =>
							record.type === "span" &&
							record.attrs.path === "/api/diagnostics/launchMarks" &&
							record.attrs.status === 200,
					),
				).toBe(true);
				yield* Effect.tryPromise(() =>
					client.diagnostics.launchMarks({
						traceId: "stale",
						marks: [
							{
								type: "mark",
								source: "frontend",
								name: "trace.done",
								at: 101,
								attrs: {},
							},
						],
					}),
				);
				expect(trace.exporter.activeId()).toBe("active");
				yield* Effect.tryPromise(() =>
					client.diagnostics.launchMarks({
						traceId: "active",
						marks: [
							{
								type: "mark",
								source: "frontend",
								name: "trace.done",
								at: 102,
								attrs: {},
							},
						],
					}),
				);
				expect(trace.exporter.activeId()).toBeUndefined();
				const finalText = yield* Effect.tryPromise(() =>
					Bun.file(launchTracePath(dir, "active")).text(),
				);
				expect(finalText).toContain('"name":"trace.done"');
			}).pipe(
				Effect.scoped,
				Effect.provide(LaunchTrace.tracingLayer),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({ NISI_DATA_DIR: dir }),
					),
				),
			),
		);
	} finally {
		await rm(dir, { recursive: true });
	}
});
