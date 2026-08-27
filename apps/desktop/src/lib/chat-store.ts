"use client";

/**
 * Client-only state for the quick-chat dock (⌘J) — threads, their messages,
 * and dock UI (which thread is active, popup open/minimized), keyed by
 * `sessionId` the same way `session-ui-store.tsx` keys per-tab UI state.
 * Threads are ephemeral by design (see the plan's "Decisions already
 * made"): this store is the frontend half of that, in-memory only, gone on
 * reload. Network orchestration — calling `chat.send`, translating
 * `ChatEvent`s into the actions below — lives in `chat-data.ts`, not here;
 * this file only knows how to hold and mutate state, the same split
 * `session-ui-store.tsx`/`walkthrough-data.ts` already draw.
 */
import {
	createContext,
	createElement,
	type ReactElement,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { createStore, type StoreApi, useStore } from "zustand";
import type { HarnessId } from "#/lib/walkthrough-data";

export type ChatMessagePart =
	| { type: "text"; text: string }
	| { type: "tool-call"; toolName: string; input: unknown };

export type ChatMessageRole = "user" | "assistant";

export type ChatMessage = {
	id: string;
	role: ChatMessageRole;
	parts: readonly ChatMessagePart[];
};

export type ChatThreadStatus = "idle" | "streaming" | "error";

export type ChatThread = {
	id: string;
	title: string;
	/**
	 * Set from the composer's harness/model picker on the thread's first
	 * message, then reused (and ignored server-side) for every later one —
	 * see `chatContract.send`'s doc comment in `packages/sidecar-api/src/chat.ts`.
	 * `null` before that first send, which is also what the composer uses to
	 * decide whether to show the picker at all.
	 */
	harness: HarnessId | null;
	model: string | undefined;
	messages: readonly ChatMessage[];
	status: ChatThreadStatus;
	errorMessage: string | null;
};

type SessionChatState = {
	threads: readonly ChatThread[];
	activeThreadId: string | null;
	popupOpen: boolean;
	popupMinimized: boolean;
};

function createDefaultSessionChatState(): SessionChatState {
	return {
		threads: [],
		activeThreadId: null,
		popupOpen: false,
		popupMinimized: false,
	};
}

const EMPTY_THREADS: readonly ChatThread[] = [];

const NEW_THREAD_TITLE = "New chat";
const TITLE_MAX_LENGTH = 40;

/** First ~40 chars of the user's first message, single-lined — mirrors how most chat apps title a new thread. */
function deriveTitle(message: string): string {
	const singleLine = message.replace(/\s+/g, " ").trim();
	if (singleLine.length <= TITLE_MAX_LENGTH)
		return singleLine || NEW_THREAD_TITLE;
	return `${singleLine.slice(0, TITLE_MAX_LENGTH).trimEnd()}…`;
}

/**
 * Reads (or lazily creates) `sessionId`'s record, applies `update`, and
 * returns a new outer `Map` with just that one entry replaced — mirrors
 * `session-ui-store.tsx`'s `withSession`, same reasoning for centralizing it.
 */
function withSession(
	sessions: ReadonlyMap<string, SessionChatState>,
	sessionId: string,
	update: (session: SessionChatState) => SessionChatState,
): ReadonlyMap<string, SessionChatState> {
	const current = sessions.get(sessionId) ?? createDefaultSessionChatState();
	const next = new Map(sessions);
	next.set(sessionId, update(current));
	return next;
}

function mapThread(
	threads: readonly ChatThread[],
	threadId: string,
	update: (thread: ChatThread) => ChatThread,
): readonly ChatThread[] {
	return threads.map((thread) =>
		thread.id === threadId ? update(thread) : thread,
	);
}

/** Appends `delta` onto `messageId`'s last text part, creating both the message and its first part if this is the turn's first delta. */
function appendAssistantText(
	thread: ChatThread,
	messageId: string,
	delta: string,
): ChatThread {
	const existing = thread.messages.find((message) => message.id === messageId);
	if (existing === undefined) {
		const message: ChatMessage = {
			id: messageId,
			role: "assistant",
			parts: [{ type: "text", text: delta }],
		};
		return { ...thread, messages: [...thread.messages, message] };
	}
	const lastPart = existing.parts[existing.parts.length - 1];
	const nextParts: readonly ChatMessagePart[] =
		lastPart !== undefined && lastPart.type === "text"
			? [
					...existing.parts.slice(0, -1),
					{ type: "text", text: lastPart.text + delta },
				]
			: [...existing.parts, { type: "text", text: delta }];
	return {
		...thread,
		messages: thread.messages.map((message) =>
			message.id === messageId ? { ...message, parts: nextParts } : message,
		),
	};
}

/** Pushes a `tool-call` part onto `messageId`, creating the message if this is the turn's first part. */
function appendAssistantToolCallPart(
	thread: ChatThread,
	messageId: string,
	toolName: string,
	input: unknown,
): ChatThread {
	const part: ChatMessagePart = { type: "tool-call", toolName, input };
	const existing = thread.messages.find((message) => message.id === messageId);
	if (existing === undefined) {
		const message: ChatMessage = {
			id: messageId,
			role: "assistant",
			parts: [part],
		};
		return { ...thread, messages: [...thread.messages, message] };
	}
	return {
		...thread,
		messages: thread.messages.map((message) =>
			message.id === messageId
				? { ...message, parts: [...message.parts, part] }
				: message,
		),
	};
}

type ChatStore = {
	sessions: ReadonlyMap<string, SessionChatState>;
	/** Creates `threadId`, makes it the active thread, and opens the popup on it — the effect of both ⌘J-with-no-threads and an explicit "new thread" action. */
	openNewThread: (sessionId: string, threadId: string) => void;
	/** Drops the thread. Closes the popup too if it was the last one. Does not call `chat.closeThread` — that's `chat-data.ts`'s job, since disposing the live harness session is a network effect. */
	closeThread: (sessionId: string, threadId: string) => void;
	setActiveThread: (sessionId: string, threadId: string) => void;
	setPopupOpen: (sessionId: string, open: boolean) => void;
	setPopupMinimized: (sessionId: string, minimized: boolean) => void;
	/** Appends the user's turn, locking in `harness`/`model` if this is the thread's first message, and marks the thread `"streaming"`. */
	appendUserMessage: (
		sessionId: string,
		threadId: string,
		messageId: string,
		text: string,
		harness: HarnessId,
		model: string | undefined,
	) => void;
	appendAssistantDelta: (
		sessionId: string,
		threadId: string,
		messageId: string,
		delta: string,
	) => void;
	appendAssistantToolCall: (
		sessionId: string,
		threadId: string,
		messageId: string,
		toolName: string,
		input: unknown,
	) => void;
	completeThread: (sessionId: string, threadId: string) => void;
	failThread: (sessionId: string, threadId: string, message: string) => void;
	/** Drops a closed PR tab's chat state entirely — call from wherever a session actually closes, mirroring `session-ui-store.tsx`'s `clearSession`. */
	clearSession: (sessionId: string) => void;
};

function createChatStore(): StoreApi<ChatStore> {
	return createStore<ChatStore>((set) => ({
		sessions: new Map(),
		openNewThread: (sessionId, threadId) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					const thread: ChatThread = {
						id: threadId,
						title: NEW_THREAD_TITLE,
						harness: null,
						model: undefined,
						messages: [],
						status: "idle",
						errorMessage: null,
					};
					return {
						...session,
						threads: [...session.threads, thread],
						activeThreadId: threadId,
						popupOpen: true,
						popupMinimized: false,
					};
				}),
			})),
		closeThread: (sessionId, threadId) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					const threads = session.threads.filter(
						(thread) => thread.id !== threadId,
					);
					const activeThreadId =
						session.activeThreadId === threadId
							? (threads[0]?.id ?? null)
							: session.activeThreadId;
					return {
						...session,
						threads,
						activeThreadId,
						popupOpen: threads.length === 0 ? false : session.popupOpen,
					};
				}),
			})),
		setActiveThread: (sessionId, threadId) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					activeThreadId: threadId,
					popupOpen: true,
					popupMinimized: false,
				})),
			})),
		setPopupOpen: (sessionId, open) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					popupOpen: open,
				})),
			})),
		setPopupMinimized: (sessionId, minimized) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					popupMinimized: minimized,
				})),
			})),
		appendUserMessage: (sessionId, threadId, messageId, text, harness, model) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					threads: mapThread(session.threads, threadId, (thread) => {
						const message: ChatMessage = {
							id: messageId,
							role: "user",
							parts: [{ type: "text", text }],
						};
						const isFirstMessage = thread.messages.length === 0;
						return {
							...thread,
							title: isFirstMessage ? deriveTitle(text) : thread.title,
							harness: thread.harness ?? harness,
							model: thread.harness === null ? model : thread.model,
							messages: [...thread.messages, message],
							status: "streaming",
							errorMessage: null,
						};
					}),
				})),
			})),
		appendAssistantDelta: (sessionId, threadId, messageId, delta) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					threads: mapThread(session.threads, threadId, (thread) =>
						appendAssistantText(thread, messageId, delta),
					),
				})),
			})),
		appendAssistantToolCall: (
			sessionId,
			threadId,
			messageId,
			toolName,
			input,
		) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					threads: mapThread(session.threads, threadId, (thread) =>
						appendAssistantToolCallPart(thread, messageId, toolName, input),
					),
				})),
			})),
		completeThread: (sessionId, threadId) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					threads: mapThread(session.threads, threadId, (thread) => ({
						...thread,
						status: "idle",
					})),
				})),
			})),
		failThread: (sessionId, threadId, message) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					threads: mapThread(session.threads, threadId, (thread) => ({
						...thread,
						status: "error",
						errorMessage: message,
					})),
				})),
			})),
		clearSession: (sessionId) =>
			set((state) => {
				if (!state.sessions.has(sessionId)) return state;
				const next = new Map(state.sessions);
				next.delete(sessionId);
				return { sessions: next };
			}),
	}));
}

const ChatStoreContext = createContext<StoreApi<ChatStore> | null>(null);

/** Raw store handle, for `chat-data.ts`'s streaming loop to dispatch several actions imperatively (`store.getState().appendAssistantDelta(...)`) without subscribing a component to every intermediate state — same pattern as `session-ui-store.tsx`'s `useSessionUndoStack`. UI components should prefer the granular selector hooks below instead. */
export function useChatStore(): StoreApi<ChatStore> {
	const store = useContext(ChatStoreContext);
	if (store === null) {
		throw new Error("useChatStore must be used within a ChatProvider");
	}
	return store;
}

/** Root of the quick-chat dock's state — mount once above the multi-PR tab strip, alongside `SessionUiProvider`. A zustand instance created once per provider (lazy `useState` initializer), not a module-level singleton, for the same reasons `SessionUiProvider` gives. */
export function ChatProvider({
	children,
}: {
	children: ReactNode;
}): ReactElement {
	const [store] = useState(createChatStore);
	return createElement(ChatStoreContext.Provider, { value: store }, children);
}

export function useChatThreads(sessionId: string): readonly ChatThread[] {
	const store = useChatStore();
	return useStore(
		store,
		(state) => state.sessions.get(sessionId)?.threads ?? EMPTY_THREADS,
	);
}

export function useChatActiveThreadId(sessionId: string): string | null {
	const store = useChatStore();
	return useStore(
		store,
		(state) => state.sessions.get(sessionId)?.activeThreadId ?? null,
	);
}

export function useChatPopupOpen(sessionId: string): boolean {
	const store = useChatStore();
	return useStore(
		store,
		(state) => state.sessions.get(sessionId)?.popupOpen ?? false,
	);
}

export function useChatPopupMinimized(sessionId: string): boolean {
	const store = useChatStore();
	return useStore(
		store,
		(state) => state.sessions.get(sessionId)?.popupMinimized ?? false,
	);
}

/** The dock-control actions UI components dispatch directly (as opposed to the network-driven message-appending actions, which only `chat-data.ts` calls) — bundled behind one hook since every dock component needs several of them together. */
export function useChatDockActions(sessionId: string): {
	openNewThread: () => string;
	closeThread: (threadId: string) => void;
	setActiveThread: (threadId: string) => void;
	setPopupOpen: (open: boolean) => void;
	setPopupMinimized: (minimized: boolean) => void;
} {
	const store = useChatStore();
	const openNewThreadAction = useStore(store, (state) => state.openNewThread);
	const closeThreadAction = useStore(store, (state) => state.closeThread);
	const setActiveThreadAction = useStore(
		store,
		(state) => state.setActiveThread,
	);
	const setPopupOpenAction = useStore(store, (state) => state.setPopupOpen);
	const setPopupMinimizedAction = useStore(
		store,
		(state) => state.setPopupMinimized,
	);

	const openNewThread = useCallback(() => {
		const threadId = crypto.randomUUID();
		openNewThreadAction(sessionId, threadId);
		return threadId;
	}, [openNewThreadAction, sessionId]);
	const closeThread = useCallback(
		(threadId: string) => closeThreadAction(sessionId, threadId),
		[closeThreadAction, sessionId],
	);
	const setActiveThread = useCallback(
		(threadId: string) => setActiveThreadAction(sessionId, threadId),
		[setActiveThreadAction, sessionId],
	);
	const setPopupOpen = useCallback(
		(open: boolean) => setPopupOpenAction(sessionId, open),
		[setPopupOpenAction, sessionId],
	);
	const setPopupMinimized = useCallback(
		(minimized: boolean) => setPopupMinimizedAction(sessionId, minimized),
		[setPopupMinimizedAction, sessionId],
	);

	return useMemo(
		() => ({
			openNewThread,
			closeThread,
			setActiveThread,
			setPopupOpen,
			setPopupMinimized,
		}),
		[
			openNewThread,
			closeThread,
			setActiveThread,
			setPopupOpen,
			setPopupMinimized,
		],
	);
}

/** Drops a closed PR tab's chat state — call from wherever a session actually closes (`app-shell.tsx`'s `handleCloseSession`), same site `useClearSessionUiState` is called from. */
export function useClearChatSession(): (sessionId: string) => void {
	const store = useChatStore();
	return useCallback(
		(sessionId: string) => store.getState().clearSession(sessionId),
		[store],
	);
}
