import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * `sessions.ts`'s `startChatSession` constructs a real `@ai-sdk/harness/agent`
 * `HarnessAgent` and calls its `createSession()` — against a real harness
 * that's a CLI subprocess bootstrap (13-28s cold, per `@repo/harness-local`'s
 * AGENTS.md) or a real network call, neither of which belongs in a unit
 * test. `HarnessAgent` is mocked at the module boundary so every test below
 * exercises `sessions.ts`'s own bookkeeping — the `threadId -> sessionId`
 * tracking and the `sessionId -> Set<threadId>` reverse index
 * `closeChatThreadsForSession` walks — against a fake session whose `stop()`
 * is directly observable, instead of a real one.
 *
 * `@repo/harness-local`'s `createLocalSandbox` is left real: it only builds
 * plain config objects (`{ provider, workDir }`); the real I/O lives behind
 * `provider.createSession()`, which the fake `HarnessAgent` below never
 * calls.
 */
let nextCreateSessionShouldFail = false;

class FakeHarnessAgentSession {
	readonly stop = mock(async () => ({}) as never);
}

class FakeHarnessAgent {
	readonly lastSession = new FakeHarnessAgentSession();
	async createSession(): Promise<FakeHarnessAgentSession> {
		if (nextCreateSessionShouldFail) {
			throw new Error("simulated createSession failure");
		}
		return this.lastSession;
	}
}

mock.module("@ai-sdk/harness/agent", () => ({
	HarnessAgent: FakeHarnessAgent,
}));

const { closeChatThread, closeChatThreadsForSession, getOrCreateChatSession } =
	await import("../sessions.ts");

let counter = 0;
/** Fresh, never-before-seen ids per test — the module's maps are process-lifetime state, not reset between tests. */
const uniqueId = (label: string): string => `${label}-${++counter}`;

const paramsFor = (sessionId: string, threadId: string) => ({
	sessionId,
	threadId,
	harness: "codex" as const,
	model: undefined,
	repoRoot: "/tmp/does-not-need-to-exist",
	instructions: "test instructions",
});

beforeEach(() => {
	nextCreateSessionShouldFail = false;
});

describe("getOrCreateChatSession", () => {
	test("constructs once per threadId and reuses it on later calls", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		const first = await getOrCreateChatSession(paramsFor(sessionId, threadId));
		const second = await getOrCreateChatSession(paramsFor(sessionId, threadId));

		expect(second.session).toBe(first.session);
	});
});

describe("closeChatThreadsForSession", () => {
	test("stops every thread scoped to the session and leaves other sessions' threads alone", async () => {
		const sessionId = uniqueId("session");
		const otherSessionId = uniqueId("session");
		const threadA = uniqueId("thread");
		const threadB = uniqueId("thread");
		const otherThread = uniqueId("thread");

		const liveA = await getOrCreateChatSession(paramsFor(sessionId, threadA));
		const liveB = await getOrCreateChatSession(paramsFor(sessionId, threadB));
		const liveOther = await getOrCreateChatSession(
			paramsFor(otherSessionId, otherThread),
		);

		await closeChatThreadsForSession(sessionId);

		expect(liveA.session.stop).toHaveBeenCalledTimes(1);
		expect(liveB.session.stop).toHaveBeenCalledTimes(1);
		expect(liveOther.session.stop).not.toHaveBeenCalled();

		// The session was disposed, not just marked — a later call for the same
		// threadId must construct a fresh one rather than handing back the
		// stopped instance.
		const revived = await getOrCreateChatSession(paramsFor(sessionId, threadA));
		expect(revived.session).not.toBe(liveA.session);
	});

	test("is a no-op for a session with no live threads", async () => {
		await expect(
			closeChatThreadsForSession(uniqueId("session")),
		).resolves.toBeUndefined();
	});

	test("tolerates a thread whose construction never resolved", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		nextCreateSessionShouldFail = true;
		// `getOrCreateChatSession` returns the in-flight (rejecting) promise —
		// a real `chat.send` handler would let this reject up to its own
		// try/catch; the thread is still tracked in the meantime.
		await expect(
			getOrCreateChatSession(paramsFor(sessionId, threadId)),
		).rejects.toThrow();

		await expect(
			closeChatThreadsForSession(sessionId),
		).resolves.toBeUndefined();
	});
});

describe("closeChatThread", () => {
	test("is a no-op for an unknown threadId", async () => {
		await expect(closeChatThread(uniqueId("thread"))).resolves.toBeUndefined();
	});

	test("removes the thread from its session's index", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		await getOrCreateChatSession(paramsFor(sessionId, threadId));
		await closeChatThread(threadId);

		// Nothing left under `sessionId` to dispose a second time.
		await expect(
			closeChatThreadsForSession(sessionId),
		).resolves.toBeUndefined();
	});
});
