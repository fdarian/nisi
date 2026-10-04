import type { Context } from "@orpc/server";
import type {
	StandardHandlerOptions,
	StandardHandlerPlugin,
	StandardHandlerRoutingInterceptor,
} from "@orpc/server/standard";
import {
	isAsyncIteratorObject,
	override,
	toArray,
	wrapAsyncIterator,
	wrapReadableStream,
} from "@orpc/shared";
import { activeTrace, writeSidecarMark } from "./launch-trace/service.ts";

type DebugLog = (
	message: string,
	fields: Record<string, unknown>,
) => Promise<void>;

export class RpcLifecyclePlugin<T extends Context>
	implements StandardHandlerPlugin<T>
{
	readonly name = "nisi/rpc-lifecycle";

	constructor(private readonly debug: DebugLog) {}

	init(options: StandardHandlerOptions<T>): StandardHandlerOptions<T> {
		const interceptor: StandardHandlerRoutingInterceptor<T> = async (call) => {
			const startedAt = Date.now();
			const trace = activeTrace();
			const path = new URL(call.request.url, "http://localhost").pathname;
			const rpcId = trace === undefined ? undefined : crypto.randomUUID();
			if (trace !== undefined)
				writeSidecarMark("rpc.start", { at: startedAt, path, rpcId }, trace);
			const signal = call.request.signal;
			const state: { finished: boolean; matched?: boolean; status?: number } = {
				finished: false,
			};
			const finish = async () => {
				if (state.finished) return;
				state.finished = true;
				if ((trace ?? activeTrace()) !== undefined)
					writeSidecarMark(
						"rpc",
						{
							path,
							rpcId,
							at: startedAt,
							durationMs: Date.now() - startedAt,
							status: state.status,
						},
						trace ?? activeTrace(),
					);
				signal?.removeEventListener("abort", onAbort);
				await this.debug("rpc call finished", {
					path,
					matched: state.matched,
					status: state.status,
					durationMs: Date.now() - startedAt,
				});
			};
			const onAbort = () => {
				void finish();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			await this.debug("rpc call started", { path });

			try {
				const result = await call.next();
				state.matched = result.matched;
				if (!result.matched) {
					await finish();
					return result;
				}
				state.status = result.response.status;
				const body = result.response.body;
				if (isAsyncIteratorObject(body)) {
					return {
						...result,
						response: {
							...result.response,
							body: override(
								body,
								wrapAsyncIterator(body, { onFinish: finish }),
							),
						},
					};
				}
				if (body instanceof ReadableStream) {
					return {
						...result,
						response: {
							...result.response,
							body: override(
								body,
								wrapReadableStream(body, { onFinish: finish }),
							),
						},
					};
				}
				await finish();
				return result;
			} catch (error) {
				await finish();
				throw error;
			}
		};
		return {
			...options,
			routingInterceptors: [
				interceptor,
				...toArray(options.routingInterceptors),
			],
		};
	}
}
