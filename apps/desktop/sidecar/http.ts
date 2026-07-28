import type { BunServices } from "@effect/platform-bun";
import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
	CORSHandlerPlugin,
	RequestHeadersHandlerPlugin,
	type RequestHeadersHandlerPluginContext,
} from "@orpc/server/plugins";
import { contract } from "@repo/sidecar-api";
import type { Context } from "effect";
import { Effect } from "effect";
import {
	emit,
	type SidecarEvent,
	subscribe as subscribeToSidecarEvents,
} from "./events.ts";
import { Store } from "./store.ts";

type ServerContext = WithEffectContext<Store | BunServices.BunServices> &
	RequestHeadersHandlerPluginContext;

/** Start the HTTP server on an ephemeral port, guarded by the bearer token. */
export function startServer(
	token: string,
	mainContext: Context.Context<Store | BunServices.BunServices>,
) {
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
		sessions: {
			open: authed.sessions.open.effect(function* ({ input, errors }) {
				const store = yield* Store;
				const session = yield* store.openSession(input.cwd).pipe(
					Effect.catchTag("InvalidCwd", (cause) =>
						Effect.fail(
							errors.BAD_REQUEST({
								message: `not a git repository: ${cause.cwd}`,
							}),
						),
					),
				);
				emit({ type: "session-opened", session });
				return session;
			}),
			list: authed.sessions.list.effect(function* () {
				const store = yield* Store;
				return yield* store.listSessions();
			}),
			close: authed.sessions.close.effect(function* ({ input, errors }) {
				const store = yield* Store;
				yield* store.closeSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				emit({ type: "session-closed", sessionId: input.sessionId });
			}),
		},
		diff: {
			files: authed.diff.files.effect(function* ({ input, errors }) {
				const store = yield* Store;
				return yield* store.listChangedFiles(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
			}),
			file: authed.diff.file.effect(function* ({ input, errors }) {
				const store = yield* Store;
				return yield* store
					.readFileContent(
						input.sessionId,
						input.path,
						input.force ?? false,
						input.oldPath,
					)
					.pipe(
						Effect.catchTag("SessionNotFound", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `session not found: ${input.sessionId}`,
								}),
							),
						),
						Effect.catchTag("FileNotChanged", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `file not in diff: ${input.path}`,
								}),
							),
						),
					);
			}),
		},
		review: {
			setViewed: authed.review.setViewed.effect(function* ({ input, errors }) {
				const store = yield* Store;
				yield* store
					.setFileViewed(input.sessionId, input.path, input.viewed)
					.pipe(
						Effect.catchTag("SessionNotFound", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `session not found: ${input.sessionId}`,
								}),
							),
						),
					);
			}),
		},
		events: {
			// Plain async-generator handler — `.effect` resolves its generator to a
			// single value via `runPromise`, so it can't hand back a live async
			// iterator. This bridges `events.ts`'s callback `subscribe` into one,
			// unsubscribing via the handler's abort `signal` on client disconnect.
			subscribe: authed.events.subscribe.handler(async function* ({ signal }) {
				const pending: Array<SidecarEvent> = [];
				let wake: (() => void) | undefined;

				const unsubscribe = subscribeToSidecarEvents((event) => {
					pending.push(event);
					wake?.();
				});

				const onAbort = () => wake?.();
				signal?.addEventListener("abort", onAbort);

				try {
					while (signal?.aborted !== true) {
						const event = pending.shift();
						if (event !== undefined) {
							yield event;
							continue;
						}
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				} finally {
					signal?.removeEventListener("abort", onAbort);
					unsubscribe();
				}
			}),
		},
	});

	const handler = new RPCHandler(router, {
		plugins: [new CORSHandlerPlugin(), new RequestHeadersHandlerPlugin()],
	});

	return Bun.serve({
		port: 0,
		// Disable idle timeout — matches the rest of the sidecar's HTTP posture
		// (long-lived connections, e.g. the event stream, shouldn't be cut by
		// Bun's default 10s timeout).
		idleTimeout: 0,
		async fetch(req) {
			const { matched, response } = await handler.handle(req, {
				prefix: "/api",
				context: { "effect/context": mainContext },
			});
			if (matched) return response;

			return new Response("not found", { status: 404 });
		},
	});
}
