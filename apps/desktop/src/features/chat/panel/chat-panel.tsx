"use client";

/**
 * The floating popup: header (title, minimize/expand/close), the active
 * thread's message list, and the composer. Fixed-position, anchored
 * bottom-right above the strip — same overlay placement precedent as the
 * toast viewport (`#/components/ui/toast.tsx`'s `Toast.Viewport`, also
 * `fixed` + a bottom-right corner). `AnimatePresence`'s mount/unmount lives
 * one level up, in `chat-dock.tsx`; this component only owns the popup's
 * own open→closed transition and the separate collapse/expand of its body
 * when minimized.
 *
 * `useChat({ chat })` (`@ai-sdk/react`), not a bespoke message/status
 * reducer — `messages`/`status`/`sendMessage`/`stop` all come straight off
 * the thread's own `Chat` instance (`chat-store.ts`'s `getOrCreateChat`),
 * which is what keeps streaming even while this component is unmounted
 * (popup closed, thread switched away from). See that file's header doc
 * for the fuller rationale.
 */
import { useChat } from "@ai-sdk/react";
import { useQuery } from "@tanstack/react-query";
import type { ChatStatus, UIMessage } from "ai";
import {
	ArrowDownIcon,
	ChevronDownIcon,
	ChevronUpIcon,
	XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ShimmerText } from "#/components/shimmer-text";
import { Button } from "#/components/ui/button";
import { ScrollArea } from "#/components/ui/scroll-area";
import {
	type ChatThreadMeta,
	deriveThreadTitle,
	getOrCreateChat,
	useChatActiveThreadId,
	useChatComposerFocusRequest,
	useChatDockActions,
	useChatPopupMinimized,
	useChatThreads,
} from "#/features/chat/chat-store";
import { useLastChatModel } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { ChatComposer } from "../chat-composer";
import { ChatMessage } from "./chat-message";
import { ChatPanelResizeHandles, useChatPanelSize } from "./chat-panel-resize";
import { type ChatScroll, useChatScroll } from "./use-chat-scroll";

export function MessageList({
	messages,
	status,
	repoRoot,
}: {
	messages: readonly UIMessage[];
	status: ChatStatus;
	repoRoot: string | undefined;
}): React.ReactElement {
	if (messages.length === 0) {
		return (
			<div className="flex h-full items-center justify-center px-6 py-8 text-center text-muted-foreground text-sm">
				Ask anything about this PR — the agent can read the worktree but won't
				change it.
			</div>
		);
	}

	const streaming = status === "streaming";
	const lastIndex = messages.length - 1;
	const isThinking =
		status === "submitted" ||
		(streaming && messages[lastIndex].role === "user");

	return (
		<div className="flex min-w-0 flex-col gap-3 px-3 py-3">
			{messages.map((message, index) => (
				<ChatMessage
					key={message.id}
					message={message}
					repoRoot={repoRoot}
					streaming={streaming && index === lastIndex}
				/>
			))}
			{isThinking && (
				<ShimmerText className="self-start text-sm">Thinking</ShimmerText>
			)}
		</div>
	);
}

/** The scrolling message list with its jump-to-latest button; `scroll` comes from `useChatScroll`, which the caller owns because sending a message re-sticks. */
export function MessageScroller({
	scroll,
	height,
	...listProps
}: {
	scroll: ChatScroll;
	height: number;
	messages: readonly UIMessage[];
	status: ChatStatus;
	repoRoot: string | undefined;
}): React.ReactElement {
	return (
		<div className="relative">
			<ScrollArea
				scrollFade
				style={{ height }}
				viewportRef={scroll.viewportRef}
			>
				<MessageList {...listProps} />
			</ScrollArea>
			{!scroll.stuckToBottom && (
				<Button
					aria-label="Jump to latest"
					className="-translate-x-1/2 absolute bottom-3 left-1/2 rounded-full"
					onClick={() => scroll.scrollToEnd("smooth")}
					size="icon-sm"
					title="Jump to latest"
					variant="outline"
				>
					<ArrowDownIcon />
				</Button>
			)}
		</div>
	);
}

type ChatPanelProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
};

export function ChatPanel({
	sessionId,
	orpc,
}: ChatPanelProps): React.ReactElement | null {
	const threads = useChatThreads(sessionId);
	const activeThreadId = useChatActiveThreadId(sessionId);

	const thread =
		threads.find((candidate) => candidate.id === activeThreadId) ?? null;
	// The strip only renders a popup at all when a thread is active
	// (`chat-dock.tsx`) — this is a defensive fallback for the render in
	// between a thread closing and the store settling on its neighbor, not a
	// reachable steady state. Returned before `ChatPanelBody` mounts, since
	// its `useChat` call needs a real thread to bind to — hooks can't be
	// called conditionally, so the null-thread branch lives in a component
	// boundary instead of an early return further down.
	if (thread === null) return null;

	return <ChatPanelBody orpc={orpc} sessionId={sessionId} thread={thread} />;
}

function ChatPanelBody({
	sessionId,
	orpc,
	thread,
}: {
	sessionId: string;
	orpc: SidecarQueryUtils;
	thread: ChatThreadMeta;
}): React.ReactElement {
	const minimized = useChatPopupMinimized(sessionId);
	const composerFocusRequest = useChatComposerFocusRequest(sessionId);
	const dock = useChatDockActions(sessionId, orpc);
	const {
		width,
		height,
		onLeftEdgePointerDown,
		onTopEdgePointerDown,
		onCornerPointerDown,
	} = useChatPanelSize();
	const [, setLastChatModel] = useLastChatModel(orpc);
	const { messages, status, error, sendMessage, stop } = useChat({
		chat: getOrCreateChat(orpc, sessionId, thread.id),
	});

	const scroll = useChatScroll(thread.id);

	const title = deriveThreadTitle(messages);
	// The same root the chat agent's sandbox is rooted at
	// (`sidecar/chat/sessions.ts`), so tool paths can be shown relative to it.
	const repoRootQuery = useQuery({
		...orpc.sessions.list.queryOptions(),
		select: (sessions) =>
			sessions.find((session) => session.id === sessionId)?.repoRoot,
	});

	return (
		<motion.div
			animate={{ opacity: 1, scale: 1, y: 0 }}
			className="fixed right-4 bottom-14 z-50 flex flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg/10"
			exit={{ opacity: 0, scale: 0.96, y: 8 }}
			initial={{ opacity: 0, scale: 0.96, y: 8 }}
			style={{ width }}
			transition={{ duration: 0.15, ease: "easeOut" }}
		>
			<ChatPanelResizeHandles
				minimized={minimized}
				onCornerPointerDown={onCornerPointerDown}
				onLeftEdgePointerDown={onLeftEdgePointerDown}
				onTopEdgePointerDown={onTopEdgePointerDown}
			/>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
				<span className="truncate font-medium text-sm">{title}</span>
				<div className="flex shrink-0 items-center gap-1">
					<Button
						aria-label={minimized ? "Expand" : "Minimize"}
						onClick={() => dock.setPopupMinimized(!minimized)}
						size="icon-xs"
						title={minimized ? "Expand" : "Minimize"}
						variant="ghost"
					>
						{minimized ? <ChevronUpIcon /> : <ChevronDownIcon />}
					</Button>
					<Button
						aria-label="Close"
						onClick={() => dock.setPopupOpen(false)}
						size="icon-xs"
						title="Close"
						variant="ghost"
					>
						<XIcon />
					</Button>
				</div>
			</div>
			<AnimatePresence initial={false}>
				{!minimized && (
					<motion.div
						animate={{ height: "auto" }}
						className="flex min-h-0 flex-col overflow-hidden"
						exit={{ height: 0 }}
						initial={{ height: 0 }}
						key="body"
						transition={{ duration: 0.15, ease: "easeOut" }}
					>
						<ScrollArea scrollFade style={{ height }}>
							<MessageList
								messages={messages}
								repoRoot={repoRootQuery.data}
								status={status}
							/>
						</ScrollArea>
						{status === "error" && error !== undefined && (
							<p className="border-t px-3 py-2 text-destructive-foreground text-xs">
								{error.message}
							</p>
						)}
						<ChatComposer
							focusRequest={composerFocusRequest}
							key={thread.id}
							onClearReferences={() => dock.clearReferences(thread.id)}
							onRemoveReference={(reference) =>
								dock.removeReference(thread.id, reference)
							}
							onSend={(text, harness, model) => {
								// Only the send that actually locks the thread's
								// harness/model in is "the user sent with this" —
								// every later send in the same thread reuses the
								// already-locked pair, so re-persisting it would
								// just be a redundant write of the same value.
								if (thread.harness === null) {
									setLastChatModel({ harness, modelId: model });
								}
								dock.lockThreadHarness(thread.id, harness, model);
								scroll.scrollToEnd();
								void sendMessage({ text }, { body: { harness, model } });
							}}
							onStop={() => void stop()}
							orpc={orpc}
							references={thread.references}
							status={status}
							threadHarness={thread.harness}
							threadModel={thread.model}
						/>
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
