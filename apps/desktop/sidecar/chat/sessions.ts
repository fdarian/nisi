import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createLocalSandbox } from "@repo/harness-local";
import type { HarnessId } from "@repo/sidecar-api";
import { createHarnessAdapter } from "../harness/harnesses.ts";
import { FILE_MUTATING_BUILTINS } from "../harness/inactive-tools.ts";
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
 * Keyed by `threadId` rather than `sessionId`: a review session can host
 * several chat threads at once (one ghost-button tab each), each its own
 * independent `HarnessAgent` conversation.
 *
 * Values are promises, not resolved entries — `getOrCreateChatSession` sets
 * the in-flight construction promise into the map *before* awaiting
 * `agent.createSession()`, so two `chat.send` calls racing on a brand-new
 * `threadId` both observe the same pending construction instead of each
 * starting (and leaking) their own sandbox/session.
 */
const liveThreads = new Map<string, Promise<LiveChatSession>>();

export type ChatSessionParams = {
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
	const agent = new HarnessAgent({
		harness: createHarnessAdapter(params.harness, params.model),
		sandbox: sandbox.provider,
		sandboxConfig: { workDir: sandbox.workDir },
		inactiveTools: FILE_MUTATING_BUILTINS[params.harness],
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
 * them, same as `walkthrough.generate`'s reattach.
 */
export const getOrCreateChatSession = (
	params: ChatSessionParams,
): Promise<LiveChatSession> => {
	const existing = liveThreads.get(params.threadId);
	if (existing !== undefined) return existing;

	const pending = startChatSession(params);
	liveThreads.set(params.threadId, pending);
	return pending;
};

/**
 * Stops the underlying harness session (releasing its sandbox/port/processes)
 * and forgets it — called on `chat.closeThread`. A no-op when nothing's live
 * for `threadId`.
 */
export const closeChatThread = async (threadId: string): Promise<void> => {
	const pending = liveThreads.get(threadId);
	if (pending === undefined) return;
	liveThreads.delete(threadId);
	const entry = await pending;
	await entry.session.stop();
};
