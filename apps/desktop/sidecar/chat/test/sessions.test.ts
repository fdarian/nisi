import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Effect } from "effect";

/**
 * `sessions.ts`'s `startChatSession` constructs a real `@ai-sdk/harness/agent`
 * `HarnessAgent` and calls its `createSession()` — against a real harness
 * that's a CLI subprocess bootstrap (13-28s cold, per `@repo/harness-local`'s
 * AGENTS.md) or a real network call, neither of which belongs in a unit
 * test. `HarnessAgent` is mocked at the module boundary so every test below
 * exercises `ChatSessions`'s own bookkeeping — the `threadId -> sessionId`
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
let nextCreateSessionShouldWait = false;
let resolvePendingCreateSession:
	| ((session: FakeHarnessAgentSession) => void)
	| undefined;
let rejectPendingCreateSession: ((error: Error) => void) | undefined;

class FakeHarnessAgentSession {
	readonly stop = mock(async () => ({}) as never);
}

class FakeHarnessAgent {
	readonly lastSession = new FakeHarnessAgentSession();
	readonly settings: Record<string, unknown>;
	constructor(settings: Record<string, unknown>) {
		this.settings = settings;
	}
	async createSession(): Promise<FakeHarnessAgentSession> {
		if (nextCreateSessionShouldFail) {
			throw new Error("simulated createSession failure");
		}
		if (nextCreateSessionShouldWait) {
			return new Promise((resolve, reject) => {
				resolvePendingCreateSession = resolve;
				rejectPendingCreateSession = reject;
			});
		}
		return this.lastSession;
	}
}

mock.module("@ai-sdk/harness/agent", () => ({
	HarnessAgent: FakeHarnessAgent,
}));

const { ChatSessions } = await import("../sessions.ts");

let counter = 0;
/** Fresh, never-before-seen ids per test — a `ChatSessions` instance is built fresh per test (see `beforeEach`) but ids stay unique anyway for clearer failure output. */
const uniqueId = (label: string): string => `${label}-${++counter}`;

const paramsFor = (sessionId: string, threadId: string) => ({
	sessionId,
	threadId,
	harness: "codex" as const,
	model: undefined,
	repoRoot: "/tmp/does-not-need-to-exist",
	instructions: "test instructions",
});

const reportFailure = (_failure: unknown): void => {};

/**
 * A fresh service instance per test — `ChatSessions.make` is a plain
 * `Effect.sync`, so running it synchronously is enough to get a real
 * instance with its own closed-over `Map`s, no layer/runtime wiring needed.
 */
let chatSessions: InstanceType<typeof ChatSessions>;

beforeEach(() => {
	nextCreateSessionShouldFail = false;
	nextCreateSessionShouldWait = false;
	resolvePendingCreateSession = undefined;
	rejectPendingCreateSession = undefined;
	chatSessions = Effect.runSync(ChatSessions.make);
});

describe("getOrCreateChatSession", () => {
	test("reconstructs after a rejected construction and retains concurrent single-flight", async () => {
		const params = paramsFor(uniqueId("session"), uniqueId("thread"));
		nextCreateSessionShouldFail = true;
		const first = chatSessions.getOrCreateChatSession(params);
		expect(chatSessions.getOrCreateChatSession(params)).toBe(first);
		await expect(first).rejects.toThrow("simulated createSession failure");
		nextCreateSessionShouldFail = false;
		const retry = chatSessions.getOrCreateChatSession(params);
		expect(retry).not.toBe(first);
		const live = await retry;
		await chatSessions.closeChatThreadsForSession(
			params.sessionId,
			reportFailure,
		);
		expect(
			(live.session as unknown as FakeHarnessAgentSession).stop,
		).toHaveBeenCalledTimes(1);
	});

	test("a late rejection does not evict a replacement thread entry", async () => {
		const params = paramsFor(uniqueId("session"), uniqueId("thread"));
		nextCreateSessionShouldWait = true;
		const pending = chatSessions.getOrCreateChatSession(params);
		const reject = rejectPendingCreateSession;
		if (reject === undefined)
			throw new Error("fake session did not expose rejection");
		const closing = chatSessions.closeChatThread(
			params.threadId,
			reportFailure,
		);
		nextCreateSessionShouldWait = false;
		const replacement = chatSessions.getOrCreateChatSession(params);
		await replacement;
		reject(new Error("late failure"));
		await expect(pending).rejects.toThrow("late failure");
		await closing;
		expect(chatSessions.getOrCreateChatSession(params)).toBe(replacement);
		const live = await replacement;
		await chatSessions.closeChatThreadsForSession(
			params.sessionId,
			reportFailure,
		);
		expect(
			(live.session as unknown as FakeHarnessAgentSession).stop,
		).toHaveBeenCalledTimes(1);
	});

	test("constructs once per threadId and reuses it on later calls", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		const first = await chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadId),
		);
		const second = await chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadId),
		);

		expect(second.session).toBe(first.session);
	});

	test("builds the HarnessAgent with no inactiveTools — chat gets the full builtin tool set, unlike walkthrough", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		const live = await chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadId),
		);

		const fakeAgent = live.agent as unknown as FakeHarnessAgent;
		expect(fakeAgent.settings.inactiveTools).toBeUndefined();
	});
});

describe("closeChatThreadsForSession", () => {
	test("stops every thread scoped to the session and leaves other sessions' threads alone", async () => {
		const sessionId = uniqueId("session");
		const otherSessionId = uniqueId("session");
		const threadA = uniqueId("thread");
		const threadB = uniqueId("thread");
		const otherThread = uniqueId("thread");

		const liveA = await chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadA),
		);
		const liveB = await chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadB),
		);
		const liveOther = await chatSessions.getOrCreateChatSession(
			paramsFor(otherSessionId, otherThread),
		);

		await chatSessions.closeChatThreadsForSession(sessionId, reportFailure);

		expect(liveA.session.stop).toHaveBeenCalledTimes(1);
		expect(liveB.session.stop).toHaveBeenCalledTimes(1);
		expect(liveOther.session.stop).not.toHaveBeenCalled();

		// The session was disposed, not just marked — a later call for the same
		// threadId must construct a fresh one rather than handing back the
		// stopped instance.
		const revived = await chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadA),
		);
		expect(revived.session).not.toBe(liveA.session);
	});

	test("is a no-op for a session with no live threads", async () => {
		await expect(
			chatSessions.closeChatThreadsForSession(
				uniqueId("session"),
				reportFailure,
			),
		).resolves.toBeUndefined();
	});

	test("closing a session after construction rejected is a no-op", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		nextCreateSessionShouldFail = true;
		await expect(
			chatSessions.getOrCreateChatSession(paramsFor(sessionId, threadId)),
		).rejects.toThrow();

		await expect(
			chatSessions.closeChatThreadsForSession(sessionId, reportFailure),
		).resolves.toBeUndefined();
	});

	test("closes promptly while construction is pending and stops a late session", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		nextCreateSessionShouldWait = true;
		const pending = chatSessions.getOrCreateChatSession(
			paramsFor(sessionId, threadId),
		);
		const resolve = resolvePendingCreateSession;
		if (resolve === undefined) {
			throw new Error("fake createSession did not expose its resolver");
		}

		const closing = chatSessions.closeChatThreadsForSession(
			sessionId,
			reportFailure,
		);
		await expect(
			chatSessions.closeChatThreadsForSession(sessionId, reportFailure),
		).resolves.toBeUndefined();

		const lateSession = new FakeHarnessAgentSession();
		resolve(lateSession);
		const live = await pending;
		expect(live.session).toBe(lateSession);
		await closing;
		await new Promise<void>((resolveNextTick) =>
			setTimeout(resolveNextTick, 0),
		);
		expect(lateSession.stop).toHaveBeenCalledTimes(1);
	});
});

describe("closeChatThread", () => {
	test("is a no-op for an unknown threadId", async () => {
		await expect(
			chatSessions.closeChatThread(uniqueId("thread"), reportFailure),
		).resolves.toBeUndefined();
	});

	test("removes the thread from its session's index", async () => {
		const sessionId = uniqueId("session");
		const threadId = uniqueId("thread");

		await chatSessions.getOrCreateChatSession(paramsFor(sessionId, threadId));
		await chatSessions.closeChatThread(threadId, reportFailure);

		// Nothing left under `sessionId` to dispose a second time.
		await expect(
			chatSessions.closeChatThreadsForSession(sessionId, reportFailure),
		).resolves.toBeUndefined();
	});
});
