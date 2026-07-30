import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { HarnessId } from "@repo/sidecar-api";
import type { WalkthroughBuffer } from "@repo/walkthrough";

/**
 * A still-live harness session from a prior `generate` call, kept around so
 * a regenerate can *continue* the conversation instead of starting cold.
 * `@repo/harness-local` deliberately omits `resumeSession` (cross-process
 * resume is unavailable by design — see its AGENTS.md), so this is
 * in-process only: gone on sidecar restart, at which point `generate` falls
 * back to a fresh run seeded with the last *stored* walkthrough instead.
 */
export type LiveWalkthroughSession = {
	readonly harness: HarnessId;
	readonly model: string | undefined;
	// biome-ignore lint/suspicious/noExplicitAny: the agent's tool-set/runtime-context type params aren't known statically here — this map only ever calls the untyped agent.stream()/session lifecycle surface, never anything that needs them.
	readonly agent: HarnessAgent<any, any>;
	readonly session: HarnessAgentSession;
	readonly buffer: WalkthroughBuffer;
};

const liveSessions = new Map<string, LiveWalkthroughSession>();

export const getLiveSession = (
	sessionId: string,
): LiveWalkthroughSession | undefined => liveSessions.get(sessionId);

export const setLiveSession = (
	sessionId: string,
	entry: LiveWalkthroughSession,
): void => {
	liveSessions.set(sessionId, entry);
};

/** Stops the underlying harness session (releasing its sandbox/port/processes) and forgets it — called on total failure and on `sessions.close`. */
export const stopLiveSession = async (sessionId: string): Promise<void> => {
	const entry = liveSessions.get(sessionId);
	if (entry === undefined) return;
	liveSessions.delete(sessionId);
	await entry.session.stop();
};
