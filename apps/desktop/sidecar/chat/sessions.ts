import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { SettingsStore } from "@repo/settings";
import type { HarnessId } from "@repo/sidecar-api";
import { Context, Effect, Layer } from "effect";
import { createHarnessAdapter } from "../harness/harnesses.ts";
import { createHarnessSandbox } from "../harness/sandbox.ts";
import type { AppServices } from "../services.ts";

/**
 * A thread's live harness session — in-process only, mirroring
 * `walkthrough/live-sessions.ts`'s `LiveWalkthroughSession`. Threads are
 * ephemeral by design (see `packages/sidecar-api/src/chat.ts`'s doc): gone
 * on sidecar restart, with no stored fallback to reattach to.
 */
export type LiveChatSession = {
	readonly harness: HarnessId;
	readonly model: string | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: the agent's tool-set/runtime-context type params aren't known statically here — this map only ever calls the untyped agent.stream()/session lifecycle surface, never anything that needs them.
	readonly agent: HarnessAgent<any, any>;
	readonly session: HarnessAgentSession;
};

/**
 * One tracked thread: the review session it's scoped to (chat threads are
 * scoped per PR tab — see `ChatSessions`'s `threadsBySession` below)
 * alongside the in-flight construction promise.
 *
 * `pending`, not a resolved value — `ChatSessions`'s `getOrCreateChatSession`
 * sets this into `liveThreads` *before* awaiting `agent.createSession()`, so
 * two `chat.send` calls racing on a brand-new `threadId` both observe the
 * same pending construction instead of each starting (and leaking) their own
 * sandbox/session.
 */
type ThreadEntry = {
	readonly sessionId: string;
	readonly pending: Promise<LiveChatSession>;
};

export type ChatThreadCloseFailure = {
	readonly sessionId: string;
	readonly threadId: string;
	readonly error: unknown;
};

export type ChatThreadCloseFailureReporter = (
	failure: ChatThreadCloseFailure,
) => void;

export type ChatSessionParams = {
	readonly sessionId: string;
	readonly threadId: string;
	readonly harness: HarnessId;
	readonly model: string | undefined;
	readonly repoRoot: string;
	readonly instructions: string;
	readonly sandboxMode: "local" | "microsandbox";
};

const startChatSession = async (
	params: ChatSessionParams,
): Promise<LiveChatSession> => {
	const sandbox = await createHarnessSandbox(
		params.harness,
		params.repoRoot,
		params.sandboxMode,
	);
	// No `inactiveTools` — chat gets every adapter builtin (write, edit, bash,
	// all of it). Unlike `walkthrough/generate.ts`, which passes
	// `sidecar/harness`'s `FILE_MUTATING_BUILTINS` to keep a walkthrough from
	// ever touching the worktree it's narrating, chat is a normal
	// conversation with the coding agent — the point is that it can actually
	// do things, not just look.
	const agent = new HarnessAgent({
		harness: createHarnessAdapter(params.harness, params.model),
		model: params.model,
		sandbox: sandbox.provider,
		sandboxConfig: { workDir: sandbox.workDir },
		instructions: params.instructions,
		telemetry: {},
	});
	const session = await agent.createSession();
	return { harness: params.harness, model: params.model, agent, session };
};

/**
 * The quick-chat popup's live thread registry, as a proper Effect service —
 * `threadId -> ThreadEntry` (`liveThreads`) plus its `sessionId ->
 * Set<threadId>` reverse index (`threadsBySession`, walked by
 * `closeChatThreadsForSession` when a review session's PR tab closes) —
 * rather than module-scope mutable globals, so this state is carried by
 * `AppServices`/`mainContext` like every other stateful piece of the
 * sidecar, not by the module import graph.
 *
 * State lives in plain closed-over `Map`s built once in `make`, not a
 * `Ref` — unlike `session-watch.ts`'s `SessionWatch` or
 * `updater/service.ts`'s `Updater`, both mutated from *inside* Effect
 * fibers via `yield*`, where `Ref`'s cross-fiber visibility is what's doing
 * the work. This service's one race-sensitive method
 * (`getOrCreateChatSession`, see its own doc) is instead always called from
 * `chat.send`'s plain `async function*` handler — a promise chain outside
 * Effect's fiber scheduler entirely — so what closes the
 * two-racing-calls window is the same thing it always was: a synchronous
 * `Map.get`/`Map.set` with no `await` between them, not `Ref`'s atomicity.
 */
export class ChatSessions extends Context.Service<ChatSessions>()(
	"sidecar/chat/sessions",
	{
		make: Effect.sync(() => {
			const liveThreads = new Map<string, ThreadEntry>();
			const threadsBySession = new Map<string, Set<string>>();

			const trackThread = (sessionId: string, threadId: string): void => {
				const threads = threadsBySession.get(sessionId);
				if (threads === undefined) {
					threadsBySession.set(sessionId, new Set([threadId]));
				} else {
					threads.add(threadId);
				}
			};

			const untrackThread = (sessionId: string, threadId: string): void => {
				const threads = threadsBySession.get(sessionId);
				if (threads === undefined) return;
				threads.delete(threadId);
				if (threads.size === 0) threadsBySession.delete(sessionId);
			};

			/**
			 * Returns `threadId`'s live session, constructing one on first use and
			 * reusing it on every later call for the same thread — multi-turn is a
			 * first-class capability of `HarnessAgent`, so a thread's whole
			 * conversation lives on one session rather than starting cold per
			 * message. `params.harness`/`params.model`/`params.instructions` only
			 * matter for that first construction; a later call against an
			 * already-live thread ignores them, same as `walkthrough.generate`'s
			 * reattach. `params.sessionId` is recorded into `threadsBySession` the
			 * first time a thread is created, so `closeChatThreadsForSession` can
			 * find it regardless of which call happened to create it — a thread's
			 * `sessionId` never changes across its lifetime, so there's nothing to
			 * refresh on a reuse.
			 */
			const getOrCreateChatSession = (
				params: ChatSessionParams,
			): Promise<LiveChatSession> => {
				const existing = liveThreads.get(params.threadId);
				if (existing !== undefined) return existing.pending;

				const pending = startChatSession(params);
				liveThreads.set(params.threadId, {
					sessionId: params.sessionId,
					pending,
				});
				trackThread(params.sessionId, params.threadId);
				return pending;
			};

			/**
			 * Stops the underlying harness session (releasing its sandbox/port/
			 * processes) and forgets it — called on `chat.closeThread` and, for
			 * every thread scoped to a review session, on `sessions.close`
			 * (`closeChatThreadsForSession` below). A no-op when nothing's live for
			 * `threadId`. Bookkeeping is removed before awaiting construction, so a
			 * later-resolving session is still stopped without keeping the thread
			 * indexed during teardown.
			 */
			const closeChatThread = async (
				threadId: string,
				reportFailure: ChatThreadCloseFailureReporter,
			): Promise<void> => {
				const entry = liveThreads.get(threadId);
				if (entry === undefined) return;
				liveThreads.delete(threadId);
				untrackThread(entry.sessionId, threadId);
				await entry.pending
					.then((live) => live.session.stop())
					.catch((error) => {
						reportFailure({
							sessionId: entry.sessionId,
							threadId,
							error,
						});
					});
			};

			/**
			 * Disposes every thread scoped to `sessionId` — `http.ts`'s
			 * `sessions.close` handler calls this the same way it already stops
			 * `walkthrough`'s live session, since a closed PR tab's chat threads
			 * have no other owner left to release their harness subprocess/
			 * sandbox. A no-op when the session never had any live threads.
			 */
			const closeChatThreadsForSession = async (
				sessionId: string,
				reportFailure: ChatThreadCloseFailureReporter,
			): Promise<void> => {
				const threadIds = threadsBySession.get(sessionId);
				if (threadIds === undefined) return;
				await Promise.allSettled(
					[...threadIds].map((threadId) =>
						closeChatThread(threadId, reportFailure),
					),
				);
			};

			return {
				getOrCreateChatSession,
				closeChatThread,
				closeChatThreadsForSession,
			};
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make);
}

const runEffect = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	mainContext: Context.Context<AppServices>,
): Promise<A> => Effect.runPromise(Effect.provide(effect, mainContext));

/**
 * `http.ts`'s `chat.send` handler is a plain `async function*`, not an
 * `.effect()` one — oRPC's effect integration can't return a live async
 * iterator (see that handler's own comment) — so it can't `yield*`
 * `ChatSessions` directly the way an `.effect()` handler would. These three
 * wrappers pull the service out of the same `mainContext` every `.effect()`
 * handler gets implicitly (captured once at boot — see `index.ts`), the same
 * bridge `chat/context.ts`'s `resolveChatPromptContext` and
 * `walkthrough/generate.ts` already use for the same reason, then hand off
 * to plain promise chaining — so a rejection from
 * `ChatSessions.getOrCreateChatSession` (an in-flight construction that
 * failed) still propagates exactly as it did before this state moved into a
 * service, with nothing Effect-specific in the way.
 */
export const getOrCreateChatSession = (
	params: Omit<ChatSessionParams, "sandboxMode">,
	mainContext: Context.Context<AppServices>,
): Promise<LiveChatSession> =>
	runEffect(
		Effect.gen(function* () {
			const chatSessions = yield* ChatSessions;
			const settings = yield* SettingsStore;
			return { chatSessions, mode: (yield* settings.get()).sandboxMode };
		}),
		mainContext,
	).then((result) =>
		result.chatSessions.getOrCreateChatSession({
			...params,
			sandboxMode: result.mode,
		}),
	);

export const closeChatThread = (
	threadId: string,
	mainContext: Context.Context<AppServices>,
	reportFailure: ChatThreadCloseFailureReporter,
): Promise<void> =>
	runEffect(ChatSessions, mainContext).then((chatSessions) =>
		chatSessions.closeChatThread(threadId, reportFailure),
	);

export const closeChatThreadsForSession = (
	sessionId: string,
	mainContext: Context.Context<AppServices>,
	reportFailure: ChatThreadCloseFailureReporter,
): Promise<void> =>
	runEffect(ChatSessions, mainContext).then((chatSessions) =>
		chatSessions.closeChatThreadsForSession(sessionId, reportFailure),
	);
