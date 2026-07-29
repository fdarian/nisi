import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
	CORSHandlerPlugin,
	RequestHeadersHandlerPlugin,
	type RequestHeadersHandlerPluginContext,
} from "@orpc/server/plugins";
import { ReviewStore } from "@repo/review";
import { SettingsStore } from "@repo/settings";
import type {
	GenerateEvent,
	HarnessId,
	Settings as WireSettings,
} from "@repo/sidecar-api";
import { contract } from "@repo/sidecar-api";
import type { Context } from "effect";
import { Effect } from "effect";
import {
	emit,
	type SidecarEvent,
	subscribe as subscribeToSidecarEvents,
} from "./events.ts";
import type { AppServices } from "./services.ts";
import { Store } from "./store.ts";
import {
	beginTrackedGeneration,
	GenerateSessionNotFound,
} from "./walkthrough/generate.ts";
import {
	attachToGeneration,
	clearGeneration,
	getGeneration,
} from "./walkthrough/generation-log.ts";
import { listHarnesses } from "./walkthrough/harnesses.ts";
import { stopLiveSession } from "./walkthrough/live-sessions.ts";
import { WalkthroughStore } from "./walkthrough/store.ts";

/**
 * `@repo/settings`'s `Settings` keeps `enabledHarnesses` as a loose
 * `string[] | null` (it stays dependency-free from this contract) — this is
 * the one place that casts it back to `HarnessId[] | null`, same as
 * `WalkthroughStore` casts its own `harness` text column at its own wire
 * boundary.
 */
const toWireSettings = (settings: {
	readonly enabledHarnesses: ReadonlyArray<string> | null;
	readonly sidebarViewMode: WireSettings["sidebarViewMode"];
	readonly diffStyleMode: WireSettings["diffStyleMode"];
}): WireSettings => ({
	enabledHarnesses:
		settings.enabledHarnesses === null
			? null
			: (settings.enabledHarnesses as ReadonlyArray<HarnessId>),
	sidebarViewMode: settings.sidebarViewMode,
	diffStyleMode: settings.diffStyleMode,
});

/**
 * `enabledHarnesses === null` means "never configured" (see
 * `@repo/settings`'s `Settings.enabledHarnesses`) — resolved here to "every
 * harness allowed" for `listHarnesses`, rather than an empty set, since an
 * unconfigured install shouldn't look like a deliberate "disable everything."
 */
const toEnabledHarnessSet = (
	enabledHarnesses: ReadonlyArray<string> | null,
): ReadonlySet<HarnessId> | null =>
	enabledHarnesses === null
		? null
		: new Set(enabledHarnesses as ReadonlyArray<HarnessId>);

type ServerContext = WithEffectContext<AppServices> &
	RequestHeadersHandlerPluginContext;

/** Start the HTTP server on an ephemeral port, guarded by the bearer token. */
export function startServer(
	token: string,
	mainContext: Context.Context<AppServices>,
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
				// A closed tab's sandbox session (spawned processes, leased port)
				// has no other owner — release it here rather than leaking it for
				// the sidecar's lifetime. Its retained generation log goes with
				// it — nothing left to reattach to once the session itself is gone.
				yield* Effect.promise(() => stopLiveSession(input.sessionId));
				clearGeneration(input.sessionId);
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
			setRangeViewed: authed.review.setRangeViewed.effect(function* ({
				input,
				errors,
			}) {
				const store = yield* Store;
				yield* store
					.setRangeViewed(
						input.sessionId,
						input.path,
						input.blockId,
						input.blockLabel,
						input.ranges,
						input.viewed,
					)
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
		walkthrough: {
			// All four adapters, each flagged `enabled` against `SettingsStore`'s
			// `enabledHarnesses` — never fails, see `listHarnesses`.
			harnesses: authed.walkthrough.harnesses.effect(function* () {
				const settingsStore = yield* SettingsStore;
				const settings = yield* settingsStore.get();
				return yield* listHarnesses(
					toEnabledHarnessSet(settings.enabledHarnesses),
				);
			}),
			get: authed.walkthrough.get.effect(function* ({ input, errors }) {
				const reviewStore = yield* ReviewStore;
				yield* reviewStore.getSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				const walkthroughStore = yield* WalkthroughStore;
				const record = yield* walkthroughStore.get(input.sessionId);
				if (record === null) return null;
				return {
					sessionId: record.sessionId,
					harness: record.harness,
					model: record.model,
					walkthrough: JSON.parse(record.content),
					fingerprints: record.fingerprints,
					generatedAt: record.generatedAt,
				};
			}),
			// A pure read over `generation-log.ts`'s in-memory state — no Store
			// call needed beyond the same session-existence check every other
			// handler here does, so a bogus sessionId gets the same NOT_FOUND
			// instead of a misleading `null`.
			activeGeneration: authed.walkthrough.activeGeneration.effect(function* ({
				input,
				errors,
			}) {
				const reviewStore = yield* ReviewStore;
				yield* reviewStore.getSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				return getGeneration(input.sessionId) ?? null;
			}),
			// Plain async-generator handler, same reason as `events.subscribe`
			// above — the multi-turn generation loop needs to push progress
			// events live, which `.effect()`'s single-resolved-value model can't.
			// Starts a generation, or reattaches to one already retained for this
			// session — see `generation-log.ts` and `generate.ts`'s
			// `beginTrackedGeneration` for how the two cases are told apart and
			// why the generation survives this specific request disconnecting.
			generate: authed.walkthrough.generate.handler(async function* ({
				input,
				errors,
			}) {
				const pending: Array<GenerateEvent> = [];
				let wake: (() => void) | undefined;
				const onEvent = (event: GenerateEvent): void => {
					pending.push(event);
					wake?.();
				};

				let unsubscribe = attachToGeneration(input.sessionId, onEvent);
				if (unsubscribe === undefined) {
					try {
						await beginTrackedGeneration(input, mainContext);
					} catch (error) {
						if (error instanceof GenerateSessionNotFound) {
							throw errors.NOT_FOUND({ message: error.message });
						}
						throw error;
					}
					unsubscribe = attachToGeneration(input.sessionId, onEvent);
				}

				try {
					while (true) {
						const event = pending.shift();
						if (event !== undefined) {
							yield event;
							if (event.type === "done" || event.type === "failed") return;
							continue;
						}
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				} finally {
					unsubscribe?.();
				}
			}),
		},
		settings: {
			get: authed.settings.get.effect(function* () {
				const store = yield* SettingsStore;
				return toWireSettings(yield* store.get());
			}),
			update: authed.settings.update.effect(function* ({ input }) {
				const store = yield* SettingsStore;
				return toWireSettings(yield* store.update(input));
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
