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
import { getToolName, isTextUIPart, isToolUIPart, type UIMessage } from "ai";
import {
	ChevronDownIcon,
	ChevronUpIcon,
	LoaderCircleIcon,
	XIcon,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown, { type Components } from "react-markdown";
import { ChatComposer } from "#/components/chat-dock/chat-composer";
import {
	ChatPanelResizeHandles,
	useChatPanelSize,
} from "#/components/chat-dock/chat-panel-resize";
import { Button } from "#/components/ui/button";
import { ScrollArea } from "#/components/ui/scroll-area";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import {
	type ChatThreadMeta,
	deriveThreadTitle,
	getOrCreateChat,
	useChatActiveThreadId,
	useChatComposerFocusRequest,
	useChatDockActions,
	useChatPopupMinimized,
	useChatThreads,
} from "#/lib/chat-store";
import { useLastChatModel } from "#/lib/settings-data";
import { cn } from "#/lib/utils";

const markdownComponents: Components = {
	p: (props) => <p className="text-foreground" {...props} />,
	ul: (props) => <ul className="list-disc space-y-1 pl-5" {...props} />,
	ol: (props) => <ol className="list-decimal space-y-1 pl-5" {...props} />,
	strong: (props) => (
		<strong className="font-semibold text-foreground" {...props} />
	),
	code: (props) => (
		<code
			{...props}
			className={cn(
				"rounded bg-background/60 px-1 py-0.5 font-mono text-[0.8125em]",
				props.className,
			)}
		/>
	),
	// Fenced blocks arrive as `<pre><code>` — the `code` renderer above still
	// fires for the nested `<code>`, so its own bg/padding/rounding are
	// cancelled here (`[&>code]:...`) rather than doubled up inside `pre`'s
	// own box. `whitespace-pre-wrap` is load-bearing: a bare `<pre>` defaults
	// to `white-space: pre`, which suppresses wrapping outright regardless of
	// `overflow-wrap`.
	pre: (props) => (
		<pre
			{...props}
			className={cn(
				"whitespace-pre-wrap wrap-anywhere rounded bg-background/60 px-2 py-1.5 font-mono text-[0.8125em] [&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0",
				props.className,
			)}
		/>
	),
	a: (props) => (
		<a
			className="underline underline-offset-2"
			rel="noreferrer"
			target="_blank"
			{...props}
		/>
	),
};

function MessageBubble({
	message,
}: {
	message: UIMessage;
}): React.ReactElement {
	const isUser = message.role === "user";
	return (
		<div
			className={cn(
				"flex min-w-0 flex-col gap-1.5",
				isUser ? "items-end" : "items-start",
			)}
		>
			{message.parts.map((part, index) => {
				if (isTextUIPart(part)) {
					return (
						<div
							className={cn(
								"min-w-0 max-w-[85%] wrap-anywhere rounded-2xl px-3 py-1.5 text-sm",
								isUser
									? "bg-primary text-primary-foreground"
									: "bg-muted text-foreground",
							)}
							// biome-ignore lint/suspicious/noArrayIndexKey: AI SDK's `TextUIPart`/`ToolUIPart` carry no id of their own (a tool part's `toolCallId` isn't stable across a thread's other tool calls' array position, and text parts have no id at all — see `process-ui-message-stream.ts`, which drops the wire chunk's `id` once a part is assembled). `parts` is append-only for a message's whole streamed lifetime, so index is a safe identity here: nothing ever reorders or is removed out from under it.
							key={index}
						>
							{isUser ? (
								<span className="whitespace-pre-wrap wrap-anywhere">
									{part.text}
								</span>
							) : (
								<ReactMarkdown components={markdownComponents}>
									{part.text}
								</ReactMarkdown>
							)}
						</div>
					);
				}
				if (isToolUIPart(part)) {
					return (
						<div
							className="min-w-0 wrap-anywhere rounded-md bg-muted/60 px-2 py-1 text-muted-foreground text-xs"
							// biome-ignore lint/suspicious/noArrayIndexKey: see the text-part branch above.
							key={index}
						>
							{getToolName(part)}
						</div>
					);
				}
				return null;
			})}
		</div>
	);
}

export function MessageList({
	messages,
	isWaitingForFirstReply,
}: {
	messages: readonly UIMessage[];
	isWaitingForFirstReply: boolean;
}): React.ReactElement {
	if (messages.length === 0) {
		return (
			<div className="flex h-full items-center justify-center px-6 py-8 text-center text-muted-foreground text-sm">
				Ask anything about this PR — the agent can read the worktree but won't
				change it.
			</div>
		);
	}

	return (
		<div className="flex min-w-0 flex-col gap-3 px-3 py-3">
			{messages.map((message) => (
				<MessageBubble key={message.id} message={message} />
			))}
			{isWaitingForFirstReply && (
				<div className="flex items-center gap-1.5 text-muted-foreground text-xs">
					<LoaderCircleIcon className="size-3 animate-spin" />
					Thinking…
				</div>
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

	const title = deriveThreadTitle(messages);
	// `"submitted"`: the turn has been sent but no chunk of the reply has
	// landed yet — AI SDK's own status expresses exactly the gap the old
	// hand-rolled indicator used to infer from `thread.status === "streaming"
	// && lastMessage.role === "user"`.
	const isWaitingForFirstReply = status === "submitted";

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
								isWaitingForFirstReply={isWaitingForFirstReply}
								messages={messages}
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
