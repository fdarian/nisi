"use client";

/**
 * Network half of the quick-chat dock — drives `chat.send`'s event stream
 * into `chat-store.ts`'s actions, following `walkthrough-data.ts`'s raw
 * `for await` shape rather than `.liveOptions()`: `text-delta`s can land
 * faster than a React commit, and `.liveOptions()` only exposes the latest
 * chunk, silently dropping same-tick ones (see `useWalkthroughGeneration`'s
 * doc comment for the full argument).
 *
 * A turn's `for await` loop is started as a detached async function, not
 * tied to any component's `useEffect` — the dock, the popup, and individual
 * thread tabs all mount/unmount independently of whether a turn is still
 * streaming (minimizing the popup, switching threads, or switching PR tabs
 * must never cut off a reply), and unlike `walkthrough.generate` there's no
 * `chat.reattach` to resume from if a stream got severed by an incidental
 * unmount. `threadControllers` is module scope, not a `useRef`, so every
 * component calling `useChatSend` shares one abort map — `stopMessage`
 * (the composer's stop button) and `closeThread` (a tab's close button)
 * routinely fire from different component instances than the `sendMessage`
 * that started the turn.
 */
import { useCallback, useMemo } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useChatStore } from "#/lib/chat-store";
import type { HarnessId } from "#/lib/walkthrough-data";

const threadControllers = new Map<string, AbortController>();

export function useChatSend(orpc: SidecarQueryUtils): {
	sendMessage: (
		sessionId: string,
		threadId: string,
		text: string,
		harness: HarnessId,
		model: string | undefined,
	) => void;
	/** Aborts `threadId`'s in-flight turn, if any — a no-op otherwise. The sidecar has no separate stop procedure; this is the oRPC request `signal` the plan calls out. */
	stopMessage: (threadId: string) => void;
	/** Aborts any in-flight turn, disposes the sidecar's live session for the thread, and drops it from the store. */
	closeThread: (sessionId: string, threadId: string) => void;
} {
	const store = useChatStore();

	const sendMessage = useCallback(
		(
			sessionId: string,
			threadId: string,
			text: string,
			harness: HarnessId,
			model: string | undefined,
		) => {
			const trimmed = text.trim();
			if (trimmed.length === 0) return;
			const thread = store
				.getState()
				.sessions.get(sessionId)
				?.threads.find((candidate) => candidate.id === threadId);
			if (thread?.status === "streaming") return;

			const messageId = crypto.randomUUID();
			store
				.getState()
				.appendUserMessage(
					sessionId,
					threadId,
					messageId,
					trimmed,
					harness,
					model,
				);

			const controller = new AbortController();
			threadControllers.set(threadId, controller);
			let assistantMessageId: string | null = null;

			void (async () => {
				try {
					const stream = await orpc.chat.send.call(
						{ sessionId, threadId, message: trimmed, harness, model },
						{ signal: controller.signal },
					);
					for await (const event of stream) {
						switch (event.type) {
							case "started":
								break;
							case "text-delta":
								assistantMessageId ??= crypto.randomUUID();
								store
									.getState()
									.appendAssistantDelta(
										sessionId,
										threadId,
										assistantMessageId,
										event.delta,
									);
								break;
							case "tool-call":
								assistantMessageId ??= crypto.randomUUID();
								store
									.getState()
									.appendAssistantToolCall(
										sessionId,
										threadId,
										assistantMessageId,
										event.toolName,
										event.input,
									);
								break;
							case "done":
								store.getState().completeThread(sessionId, threadId);
								break;
							case "error":
								store.getState().failThread(sessionId, threadId, event.message);
								break;
						}
					}
				} catch (error) {
					// A deliberate abort (stopMessage/closeThread) rejects the loop
					// too — treat it as a quiet stop, not a failure banner, mirroring
					// how `useWalkthroughGeneration`'s stop button never surfaces an
					// error for a generation the user cancelled on purpose.
					if (controller.signal.aborted) {
						store.getState().completeThread(sessionId, threadId);
						return;
					}
					store
						.getState()
						.failThread(
							sessionId,
							threadId,
							error instanceof Error ? error.message : String(error),
						);
				} finally {
					if (threadControllers.get(threadId) === controller) {
						threadControllers.delete(threadId);
					}
				}
			})();
		},
		[orpc, store],
	);

	const stopMessage = useCallback((threadId: string) => {
		threadControllers.get(threadId)?.abort();
	}, []);

	const closeThread = useCallback(
		(sessionId: string, threadId: string) => {
			threadControllers.get(threadId)?.abort();
			threadControllers.delete(threadId);
			// Best-effort: an already-gone thread (its owning PR session closed
			// and the sidecar disposed it first) is a harmless no-op server-side,
			// nothing here needs to react to a failed call.
			void orpc.chat.closeThread.call({ threadId }).catch(() => {});
			store.getState().closeThread(sessionId, threadId);
		},
		[orpc, store],
	);

	return useMemo(
		() => ({ sendMessage, stopMessage, closeThread }),
		[sendMessage, stopMessage, closeThread],
	);
}
