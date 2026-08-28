import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createLocalSandbox } from "@repo/harness-local";
import type { HarnessId } from "@repo/sidecar-api";
import { createHarnessAdapter } from "../harness/harnesses.ts";
import { resolveSandboxSettings } from "../harness/sandbox.ts";

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
 * scoped per PR tab — see `sessionsBySession` below) alongside the in-flight
 * construction promise.
 *
 * `pending`, not a resolved value — `getOrCreateChatSession` sets this into
 * `liveThreads` *before* awaiting `agent.createSession()`, so two `chat.send`
 * calls racing on a brand-new `threadId` both observe the same pending
 * construction instead of each starting (and leaking) their own
 * sandbox/session.
 */
type ThreadEntry = {
	readonly sessionId: string;
	readonly pending: Promise<LiveChatSession>;
};

/**
 * Keyed by `threadId` rather than `sessionId`: a review session can host
 * several chat threads at once (one ghost-button tab each), each its own
 * independent `HarnessAgent` conversation.
 */
const liveThreads = new Map<string, ThreadEntry>();

/**
 * `sessionId -> Set<threadId>` — the reverse index `closeChatThreadsForSession`
 * walks when a review session (a PR tab) closes. Every thread a review
 * session ever started stays reachable from here until it's disposed, kept
 * in sync with `liveThreads` solely by `trackThread`/`untrackThread` below —
 * closing a PR tab must dispose every thread scoped to it, or its harness
 * subprocess/sandbox leaks for the rest of the sidecar's lifetime.
 */
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

export type ChatSessionParams = {
	readonly sessionId: string;
	readonly threadId: string;
	readonly harness: HarnessId;
	readonly model: string | undefined;
	readonly repoRoot: string;
	readonly instructions: string;
};

const startChatSession = async (
	params: ChatSessionParams,
): Promise<LiveChatSession> => {
	const sandbox = createLocalSandbox(
		resolveSandboxSettings(params.harness, params.repoRoot),
	);
	// No `inactiveTools` — chat gets every adapter builtin (write, edit, bash,
	// all of it). Unlike `walkthrough/generate.ts`, which passes
	// `sidecar/harness`'s `FILE_MUTATING_BUILTINS` to keep a walkthrough from
	// ever touching the worktree it's narrating, chat is a normal
	// conversation with the coding agent — the point is that it can actually
	// do things, not just look.
	const agent = new HarnessAgent({
		harness: createHarnessAdapter(params.harness, params.model),
		sandbox: sandbox.provider,
		sandboxConfig: { workDir: sandbox.workDir },
		instructions: params.instructions,
		telemetry: {},
	});
	const session = await agent.createSession();
	return { harness: params.harness, model: params.model, agent, session };
};

/**
 * Returns `threadId`'s live session, constructing one on first use and
 * reusing it on every later call for the same thread — multi-turn is a
 * first-class capability of `HarnessAgent`, so a thread's whole conversation
 * lives on one session rather than starting cold per message.
 * `params.harness`/`params.model`/`params.instructions` only matter for that
 * first construction; a later call against an already-live thread ignores
 * them, same as `walkthrough.generate`'s reattach. `params.sessionId` is
 * tracked on every call (including a reuse) so `closeChatThreadsForSession`
 * can find this thread regardless of which call happened to create it.
 */
export const getOrCreateChatSession = (
	params: ChatSessionParams,
): Promise<LiveChatSession> => {
	const existing = liveThreads.get(params.threadId);
	if (existing !== undefined) return existing.pending;

	const pending = startChatSession(params);
	liveThreads.set(params.threadId, { sessionId: params.sessionId, pending });
	trackThread(params.sessionId, params.threadId);
	return pending;
};

/**
 * Stops the underlying harness session (releasing its sandbox/port/processes)
 * and forgets it — called on `chat.closeThread` and, for every thread scoped
 * to a review session, on `sessions.close` (`closeChatThreadsForSession`
 * below). A no-op when nothing's live for `threadId`. Tolerates a
 * construction that never finished (`agent.createSession()` failed, or is
 * still in flight when disposed) — there's nothing live to stop in that
 * case, so it's dropped rather than left to reject a caller that's only
 * trying to clean up.
 */
export const closeChatThread = async (threadId: string): Promise<void> => {
	const entry = liveThreads.get(threadId);
	if (entry === undefined) return;
	liveThreads.delete(threadId);
	untrackThread(entry.sessionId, threadId);
	const live = await entry.pending.catch(() => undefined);
	if (live === undefined) return;
	await live.session.stop();
};

/**
 * Disposes every thread scoped to `sessionId` — `http.ts`'s `sessions.close`
 * handler calls this the same way it already stops `walkthrough`'s live
 * session, since a closed PR tab's chat threads have no other owner left to
 * release their harness subprocess/sandbox. A no-op when the session never
 * had any live threads.
 */
export const closeChatThreadsForSession = async (
	sessionId: string,
): Promise<void> => {
	const threadIds = threadsBySession.get(sessionId);
	if (threadIds === undefined) return;
	await Promise.all(
		[...threadIds].map((threadId) => closeChatThread(threadId)),
	);
};
