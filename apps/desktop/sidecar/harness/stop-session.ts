import type { HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { HarnessSandboxSession } from "./sandbox.ts";

/** Destroys the sandbox session even when `stop()` throws, so a failed stop can't leak its leased port and spawned processes. */
export const stopHarnessSession = async (live: {
	readonly session: HarnessAgentSession;
	readonly sandboxSession: HarnessSandboxSession;
}): Promise<void> => {
	try {
		await live.session.stop();
	} finally {
		await live.sandboxSession.destroy();
	}
};
