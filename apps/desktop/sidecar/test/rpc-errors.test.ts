import { expect, test } from "bun:test";
import { createRouterClient, ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Cause, Effect, Logger } from "effect";
import { RpcErrorsPlugin } from "../rpc-errors.ts";

test("unexpected rejection logs its full error and preserves the message", async () => {
	const error = new Error(
		"claude-code bridge exited before becoming ready. Exit code: 1.\n\nstderr:\nCannot find package 'ws'",
	);
	const entries: { error: unknown; path: readonly string[] }[] = [];
	const lines: string[] = [];
	const logger = Logger.make((options) => {
		lines.push(Logger.formatLogFmt.log(options));
	});
	const plugin = new RpcErrorsPlugin(async (failure, path) => {
		entries.push({ error: failure, path });
		await Effect.runPromise(
			Effect.logError("rpc call failed", Cause.die(failure)).pipe(
				Effect.annotateLogs({ path: path.join(".") }),
				Effect.provide(Logger.layer([logger])),
			),
		);
	});
	const router = {
		chat: {
			send: os.handler(() => {
				throw error;
			}),
		},
	};
	const client = createRouterClient(router, {
		interceptors: plugin.init({}).clientInterceptors,
	});
	await expect(client.chat.send()).rejects.toMatchObject({
		code: "INTERNAL_SERVER_ERROR",
		message: error.message,
		cause: error,
	});
	expect(entries).toEqual([{ error, path: ["chat", "send"] }]);
	expect(lines[0]).toContain("level=ERROR");
	expect(lines[0]).toContain("path=chat.send");
	expect(lines[0]).toContain("Cannot find package 'ws'");
	expect(lines[0]).toContain("rpc-errors.test.ts");
	console.info("Bridge-startup log example:", lines[0]);
});

test("4xx errors pass through unchanged without error logging", async () => {
	const error = new ORPCError("NOT_FOUND", { message: "session missing" });
	const entries: unknown[] = [];
	const plugin = new RpcErrorsPlugin(async (failure) => {
		entries.push(failure);
	});
	const client = createRouterClient(
		{
			fail: os.handler(() => {
				throw error;
			}),
		},
		{
			interceptors: plugin.init({}).clientInterceptors,
		},
	);
	await expect(client.fail()).rejects.toBe(error);
	expect(entries).toEqual([]);
});

test("5xx ORPCError messages are preserved and logged", async () => {
	const error = new ORPCError("SERVICE_UNAVAILABLE", {
		message: "bridge unavailable",
	});
	const entries: unknown[] = [];
	const plugin = new RpcErrorsPlugin(async (failure) => {
		entries.push(failure);
	});
	const client = createRouterClient(
		{
			fail: os.handler(() => {
				throw error;
			}),
		},
		{
			interceptors: plugin.init({}).clientInterceptors,
		},
	);
	await expect(client.fail()).rejects.toMatchObject({
		code: "INTERNAL_SERVER_ERROR",
		message: error.message,
	});
	expect(entries).toEqual([error]);
});

test("mid-stream errors are logged once and preserve their message", async () => {
	const error = new Error("bridge disconnected");
	const entries: unknown[] = [];
	const plugin = new RpcErrorsPlugin(async (failure) => {
		entries.push(failure);
	});
	const client = createRouterClient(
		{
			stream: os.handler(async function* () {
				yield "first";
				throw error;
			}),
		},
		{ interceptors: plugin.init({}).clientInterceptors },
	);
	const stream = await client.stream();
	expect(await stream.next()).toMatchObject({ value: "first", done: false });
	await expect(stream.next()).rejects.toMatchObject({
		code: "INTERNAL_SERVER_ERROR",
		message: error.message,
		cause: error,
	});
	expect(entries).toEqual([error]);
});

test("fetch handler sends the original failure message over the wire", async () => {
	const plugin = new RpcErrorsPlugin(async () => {});
	const handler = new RPCHandler(
		{
			fail: os.handler(() => {
				throw new Error("bridge startup failed");
			}),
		},
		{ plugins: [plugin] },
	);
	const result = await handler.handle(
		new Request("http://localhost/api/fail", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: null }),
		}),
		{ prefix: "/api" },
	);
	if (!result.matched) throw new Error("RPC did not match");
	expect(result.response.status).toBe(500);
	expect(await result.response.text()).toContain("bridge startup failed");
});
