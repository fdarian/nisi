import { expect, test } from "bun:test";
import { os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RpcLifecyclePlugin } from "../rpc-lifecycle.ts";

test("logs completed RPCs through the shared handler plugin", async () => {
	const entries: { message: string; fields: Record<string, unknown> }[] = [];
	const plugin = new RpcLifecyclePlugin(async (message, fields) => {
		entries.push({ message, fields });
	});
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
		durationMs: expect.any(Number),
	});
});
