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
import { Effect, Exit, type Tracer } from "effect";

type DebugLog = (
	message: string,
	fields: Record<string, unknown>,
) => Promise<void>;

export class RpcLifecyclePlugin<T extends Context>
	implements StandardHandlerPlugin<T>
{
	readonly name = "nisi/rpc-lifecycle";

	constructor(
		private readonly debug: DebugLog,
		private readonly runTrace: <A>(effect: Effect.Effect<A>) => Promise<A>,
		private readonly parentContext?: (context: T, span: Tracer.Span) => T,
	) {}

	init(options: StandardHandlerOptions<T>): StandardHandlerOptions<T> {
		const interceptor: StandardHandlerRoutingInterceptor<T> = async (call) => {
			const path = new URL(call.request.url, "http://localhost").pathname;
			const span = await this.runTrace(
				Effect.makeSpan("rpc", {
					root: true,
					kind: "server",
					attributes: { path },
				}),
			);
			const signal = call.request.signal;
			const state: { finished: boolean; matched?: boolean; status?: number } = {
				finished: false,
			};
			const finish = async () => {
				if (state.finished) return;
				state.finished = true;
				if (state.status !== undefined) span.attribute("status", state.status);
				span.end(BigInt(Date.now()) * 1_000_000n, Exit.void);
				signal?.removeEventListener("abort", onAbort);
				await this.debug("rpc call finished", {
					path,
					matched: state.matched,
					status: state.status,
				});
			};
			const onAbort = () => {
				void finish();
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			await this.debug("rpc call started", { path });

			try {
				const result = await call.next({
					request: call.request,
					prefix: call.prefix,
					context:
						this.parentContext === undefined
							? call.context
							: this.parentContext(call.context, span),
				});
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
