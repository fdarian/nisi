"use client";

/**
 * Client-only state for the quick-chat dock (⌘J) — the thread list and dock
 * UI (which thread is active, popup open/minimized), keyed by `sessionId`
 * the same way `session-ui-store.tsx` keys per-tab UI state, plus the
 * module-scope `Map<threadId, Chat>` every thread's messages and streaming
 * status actually live on now.
 *
 * Revision: this used to also own a `messages` array and an
 * `"idle"/"streaming"/"error"` status per thread, hand-appended delta-by-delta
 * by a `chat-data.ts` streaming loop mirroring `walkthrough-data.ts`'s raw
 * `for await` shape. Both are gone, and `chat-data.ts` with them — AI SDK's
 * `Chat` class (`@ai-sdk/react`) already does that job (message assembly,
 * `status`, the tool-part state machine), and does it better than a
 * hand-rolled projection ever would. `getOrCreateChat` below is what
 * replaces `chat-data.ts`'s old `threadControllers` map: a `Chat` instance
 * keeps streaming with no subscriber mounted the same way an
 * `AbortController` did, so it's the correct module-scope home for "the
 * thing that must survive an unmount" — switching threads, minimizing the
 * popup, or switching PR tabs must never cut off a reply.
 *
 * What's left here is genuinely just state: which threads exist, which is
 * active/open, and — since AI SDK's `Chat` has no concept of them —
 * `harness`/`model`, locked in on a thread's first message and reused
 * (server-side too, see `chatContract.send`'s doc) for every one after.
 */
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
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
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { createOrpcChatTransport, messageText } from "#/lib/chat-transport";
import type { HarnessId } from "#/lib/walkthrough-data";

export type ChatThreadMeta = {
	id: string;
	/**
	 * Set from the composer's harness/model picker on the thread's first
	 * message, then reused (and ignored server-side) for every later one —
	 * see `chatContract.send`'s doc comment in `packages/sidecar-api/src/chat.ts`.
	 * `null` before that first send, which is also what the composer uses to
	 * decide whether to show the picker at all.
	 */
	harness: HarnessId | null;
	model: string | undefined;
};

type SessionChatState = {
	threads: readonly ChatThreadMeta[];
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

const EMPTY_THREADS: readonly ChatThreadMeta[] = [];

const NEW_THREAD_TITLE = "New chat";
const TITLE_MAX_LENGTH = 40;

/**
 * First ~40 chars of the thread's first user message, single-lined —
 * mirrors how most chat apps title a new thread. Derived live from AI SDK's
 * own `messages` on every render rather than stored, now that this file
 * doesn't own message content at all — there's nowhere left to cache it
 * that wouldn't just be a second, driftable copy.
 */
export function deriveThreadTitle(messages: readonly UIMessage[]): string {
	const firstUserMessage = messages.find((message) => message.role === "user");
	if (firstUserMessage === undefined) return NEW_THREAD_TITLE;
	const singleLine = messageText(firstUserMessage).replace(/\s+/g, " ").trim();
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
	threads: readonly ChatThreadMeta[],
	threadId: string,
	update: (thread: ChatThreadMeta) => ChatThreadMeta,
): readonly ChatThreadMeta[] {
	return threads.map((thread) =>
		thread.id === threadId ? update(thread) : thread,
	);
}

/**
 * The live `Chat` instances backing every thread that's ever sent a message
 * — module scope, not component state, for the same reason the old
 * `threadControllers` map was (see this file's header doc): the dock, the
 * popup, and individual thread tabs all mount/unmount independently of
 * whether a turn is still streaming, and a `Chat` instance only keeps
 * streaming for as long as something holds a reference to it. Keyed by
 * `threadId`, same as the sidecar's own live-session map
 * (`sidecar/chat/sessions.ts`) — a thread's `Chat` and its sidecar-side
 * `HarnessAgentSession` are meant to have the same lifetime, and
 * `closeThread`/`clearSession` below are what keep that true on the
 * frontend's side of it.
 */
const chatInstances = new Map<string, Chat<UIMessage>>();

/**
 * Returns `threadId`'s live `Chat` instance, constructing one — wired to
 * `chat.send` via `createOrpcChatTransport` — on first use, and reusing it
 * on every later call for the same thread. Safe to call on every render
 * (the common case is just a `Map.get`); the identity only changes when a
 * thread is actually new, which is exactly what `useChat({ chat })` needs
 * to key its own subscription off of.
 */
export function getOrCreateChat(
	orpc: SidecarQueryUtils,
	sessionId: string,
	threadId: string,
): Chat<UIMessage> {
	const existing = chatInstances.get(threadId);
	if (existing !== undefined) return existing;
	const chat = new Chat<UIMessage>({
		id: threadId,
		transport: createOrpcChatTransport(orpc, sessionId, threadId),
	});
	chatInstances.set(threadId, chat);
	return chat;
}

type ChatStore = {
	sessions: ReadonlyMap<string, SessionChatState>;
	/** Creates `threadId`, makes it the active thread, and opens the popup on it — the effect of both ⌘J-with-no-threads and an explicit "new thread" action. */
	openNewThread: (sessionId: string, threadId: string) => void;
	/**
	 * Drops the thread's metadata, stops and drops its `Chat` instance from
	 * `chatInstances`. Does not call `chat.closeThread` — that's a network
	 * effect that needs `orpc`, which this store doesn't have; it's
	 * `useChatDockActions`' job, below.
	 */
	closeThread: (sessionId: string, threadId: string) => void;
	setActiveThread: (sessionId: string, threadId: string) => void;
	setPopupOpen: (sessionId: string, open: boolean) => void;
	setPopupMinimized: (sessionId: string, minimized: boolean) => void;
	/** Locks in `harness`/`model` the first time a thread sends a message — a no-op on every later call for the same thread, mirroring the sidecar's own "first send wins" reattach posture. */
	lockThreadHarness: (
		sessionId: string,
		threadId: string,
		harness: HarnessId,
		model: string | undefined,
	) => void;
	/** Drops a closed PR tab's chat state entirely, including every one of its threads' `Chat` instances — call from wherever a session actually closes, mirroring `session-ui-store.tsx`'s `clearSession`. */
	clearSession: (sessionId: string) => void;
};

/** Stops (best-effort) and forgets `threadId`'s live `Chat` instance, if any. */
function disposeChatInstance(threadId: string): void {
	void chatInstances.get(threadId)?.stop();
	chatInstances.delete(threadId);
}

function createChatStore(): StoreApi<ChatStore> {
	return createStore<ChatStore>((set) => ({
		sessions: new Map(),
		openNewThread: (sessionId, threadId) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => {
					const thread: ChatThreadMeta = {
						id: threadId,
						harness: null,
						model: undefined,
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
		closeThread: (sessionId, threadId) => {
			disposeChatInstance(threadId);
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
			}));
		},
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
		lockThreadHarness: (sessionId, threadId, harness, model) =>
			set((state) => ({
				sessions: withSession(state.sessions, sessionId, (session) => ({
					...session,
					threads: mapThread(session.threads, threadId, (thread) =>
						thread.harness === null ? { ...thread, harness, model } : thread,
					),
				})),
			})),
		clearSession: (sessionId) =>
			set((state) => {
				const session = state.sessions.get(sessionId);
				if (session === undefined) return state;
				for (const thread of session.threads) disposeChatInstance(thread.id);
				const next = new Map(state.sessions);
				next.delete(sessionId);
				return { sessions: next };
			}),
	}));
}

const ChatStoreContext = createContext<StoreApi<ChatStore> | null>(null);

/** Raw store handle for imperative dispatch outside a selector hook. UI components should prefer the granular selector hooks below instead. */
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

export function useChatThreads(sessionId: string): readonly ChatThreadMeta[] {
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

/**
 * The dock-control actions UI components dispatch directly — bundled behind
 * one hook since every dock component needs several of them together.
 * `closeThread` here (unlike the store's own action of the same name) also
 * fires the `chat.closeThread` RPC, which is why this hook takes `orpc`:
 * the store can drop local state and dispose the `Chat` instance on its
 * own, but telling the sidecar to release the underlying harness
 * session/sandbox needs the network.
 */
export function useChatDockActions(
	sessionId: string,
	orpc: SidecarQueryUtils,
): {
	openNewThread: () => string;
	closeThread: (threadId: string) => void;
	setActiveThread: (threadId: string) => void;
	setPopupOpen: (open: boolean) => void;
	setPopupMinimized: (minimized: boolean) => void;
	lockThreadHarness: (
		threadId: string,
		harness: HarnessId,
		model: string | undefined,
	) => void;
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
	const lockThreadHarnessAction = useStore(
		store,
		(state) => state.lockThreadHarness,
	);

	const openNewThread = useCallback(() => {
		const threadId = crypto.randomUUID();
		openNewThreadAction(sessionId, threadId);
		return threadId;
	}, [openNewThreadAction, sessionId]);
	const closeThread = useCallback(
		(threadId: string) => {
			// Best-effort: an already-gone thread (its owning PR session closed
			// and the sidecar disposed it first) is a harmless no-op server-side,
			// nothing here needs to react to a failed call.
			void orpc.chat.closeThread.call({ threadId }).catch(() => {});
			closeThreadAction(sessionId, threadId);
		},
		[orpc, closeThreadAction, sessionId],
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
	const lockThreadHarness = useCallback(
		(threadId: string, harness: HarnessId, model: string | undefined) =>
			lockThreadHarnessAction(sessionId, threadId, harness, model),
		[lockThreadHarnessAction, sessionId],
	);

	return useMemo(
		() => ({
			openNewThread,
			closeThread,
			setActiveThread,
			setPopupOpen,
			setPopupMinimized,
			lockThreadHarness,
		}),
		[
			openNewThread,
			closeThread,
			setActiveThread,
			setPopupOpen,
			setPopupMinimized,
			lockThreadHarness,
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
