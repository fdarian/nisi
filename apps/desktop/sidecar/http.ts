import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
	CORSHandlerPlugin,
	RequestHeadersHandlerPlugin,
	type RequestHeadersHandlerPluginContext,
} from "@orpc/server/plugins";
import { contract } from "@repo/sidecar-api";
import { Context } from "effect";

// Phase 0 has no domain services yet (no Store/DB) — `never` is the honest
// requirement type. Swap in a real service union (and a built `Context.Context`
// below) once the sidecar grows one.
type ServerContext = WithEffectContext<never> &
	RequestHeadersHandlerPluginContext;

/** Start the HTTP server on an ephemeral port, guarded by the bearer token. */
export function startServer(token: string) {
	const implementer = implement(contract).$context<ServerContext>();

	const authed = implementer.use(({ context, next, errors }) => {
		const header = context.reqHeaders?.get("authorization");
		if (header !== `Bearer ${token}`) {
			throw errors.UNAUTHORIZED({ message: "missing or invalid bearer token" });
		}
		return next();
	});

	const router = authed.router({
		health: {
			// biome-ignore lint/correctness/useYield: .effect() requires a generator function even with no Effect steps
			check: authed.health.check.effect(function* () {
				return { status: "ok" as const };
			}),
		},
	});

	const handler = new RPCHandler(router, {
		plugins: [new CORSHandlerPlugin(), new RequestHeadersHandlerPlugin()],
	});

	return Bun.serve({
		port: 0,
		// Disable idle timeout — matches the rest of the sidecar's HTTP posture
		// (long-lived connections, e.g. future event streams, shouldn't be cut by
		// Bun's default 10s timeout).
		idleTimeout: 0,
		async fetch(req) {
			const { matched, response } = await handler.handle(req, {
				prefix: "/api",
				context: { "effect/context": Context.empty() },
			});
			if (matched) return response;

			return new Response("not found", { status: 404 });
		},
	});
}
