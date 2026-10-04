import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ConfigProvider, Effect } from "effect";
import { LoggingLive } from "../logging.ts";
import { createNativeActivationHandler } from "../native-activation.ts";
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
import { activeTrace, LaunchTrace, writeSidecarMark } from "./service.ts";

test("failed trace writes preserve open requests, activation clearing and trace completion", async () => {
	const dataDir = mkdtempSync(join(tmpdir(), "nisi-launch-service-failure-"));
	try {
		mkdirSync(traceFilePath(dataDir, "write-failure"), { recursive: true });
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const trace = yield* LaunchTrace;
					const context = yield* Effect.context<never>();
					const runTrace = (effect: Effect.Effect<void>) =>
						Effect.runPromise(Effect.provide(effect, context));
					yield* trace.activate("write-failure");
					const request = createOpenRequest(
						"/repo",
						{ kind: "auto" },
						"write-failure",
					);
					yield* writeSidecarMark("sidecar.open-requested.emitted", {
						requestId: request.id,
					});
					const session = {
						id: "session",
						repoRoot: "/repo",
						target: { kind: "branch", baseRef: "main", headRef: "feature" },
					} as const;
					try {
						resolveOpenRequest(request.id, session);
						yield* writeSidecarMark("sidecar.open-resolved.emitted", {
							requestId: request.id,
						});
						expect(
							listOpenRequests().find((entry) => entry.id === request.id)
								?.status,
						).toEqual({ kind: "opened", session });
						const activation = createNativeActivationHandler(
							"token",
							"owner",
							(id) =>
								runTrace(
									writeSidecarMark("sidecar.activation.acked", {
										requestId: id,
									}),
								),
						);
						const acknowledged = yield* Effect.tryPromise(() =>
							activation(
								new Request(
									`http://localhost/native/activation/ack?id=${request.id}`,
									{
										method: "POST",
										headers: {
											authorization: "Bearer token",
											"x-nisi-activation-owner": "owner",
										},
									},
								),
							),
						);
						expect(acknowledged?.status).toBe(204);
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
						{ plugins: [new RpcLifecyclePlugin(async () => {}, runTrace)] },
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
				}),
			).pipe(
				Effect.provide(LaunchTrace.layer),
				Effect.provide(LoggingLive),
				Effect.provide(BunServices.layer),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
					),
				),
			),
		);
		const log = readFileSync(join(dataDir, "logs", "sidecar.log"), "utf8");
		expect(log).toContain("level=WARN");
		expect(log).toContain("Launch trace write failed");
		expect(log).toContain("write-failure");
		expect(log.match(/Launch trace write failed/g)).toHaveLength(7);
	} finally {
		rmSync(dataDir, { recursive: true });
	}
});
