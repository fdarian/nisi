import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ConfigProvider, Effect } from "effect";
import {
	acknowledgeActivation,
	acknowledgeOpenRequest,
	createOpenRequest,
	listOpenRequests,
	resolveOpenRequest,
	subscribeToActivations,
} from "../open-requests.ts";
import { RpcLifecyclePlugin } from "../rpc-lifecycle.ts";
import { traceFilePath } from "./file-writer.ts";
import { activeTrace, LaunchTrace } from "./service.ts";

test("failed trace writes preserve open requests, activation clearing and trace completion", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nisi-launch-service-failure-"));
	const warn = spyOn(console, "error").mockImplementation(() => {});
	try {
		mkdirSync(traceFilePath(dataDir, "write-failure"), { recursive: true });
		await Effect.runPromise(
			Effect.gen(function* () {
				const trace = yield* LaunchTrace;
				yield* trace.activate("write-failure");
				const request = createOpenRequest(
					"/repo",
					{ kind: "auto" },
					"write-failure",
				);
				const session = {
					id: "session",
					repoRoot: "/repo",
					target: { kind: "branch", baseRef: "main", headRef: "feature" },
				} as const;
				try {
					resolveOpenRequest(request.id, session);
					expect(
						listOpenRequests().find((entry) => entry.id === request.id)?.status,
					).toEqual({ kind: "opened", session });
					acknowledgeActivation(request.id);
					const activations: string[] = [];
					const stop = subscribeToActivations((id) => activations.push(id));
					stop();
					expect(activations).not.toContain(request.id);
				} finally {
					acknowledgeOpenRequest(request.id);
					acknowledgeActivation(request.id);
				}
				const handler = new RPCHandler(
					{
						fail: os.handler(() => {
							throw new ORPCError("BAD_REQUEST", {
								message: "original RPC failure",
							});
						}),
					},
					{ plugins: [new RpcLifecyclePlugin(async () => {})] },
				);
				const result = yield* Effect.tryPromise(() =>
					handler.handle(
						new Request("http://localhost/api/fail", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ json: null }),
						}),
						{ prefix: "/api" },
					),
				);
				expect(result.response?.status).toBe(400);
				if (result.response === undefined)
					return yield* Effect.die(new Error("RPC response missing"));
				const response = result.response;
				expect(yield* Effect.tryPromise(() => response.text())).toContain(
					"original RPC failure",
				);
				yield* trace.frontend("write-failure", [
					{ at: Date.now(), name: "trace.done" },
				]);
				expect(activeTrace()).toBeUndefined();
			}).pipe(
				Effect.provide(LaunchTrace.layer),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
					),
				),
			),
		);
		expect(warn).toHaveBeenCalled();
	} finally {
		warn.mockRestore();
		rmSync(dataDir, { recursive: true });
	}
});
