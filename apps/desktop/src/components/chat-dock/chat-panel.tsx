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
 */
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown, { type Components } from "react-markdown";
import { ChatComposer } from "#/components/chat-dock/chat-composer";
import { Button } from "#/components/ui/button";
import { ScrollArea } from "#/components/ui/scroll-area";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useChatSend } from "#/lib/chat-data";
import {
	type ChatMessage,
	useChatActiveThreadId,
	useChatDockActions,
	useChatPopupMinimized,
	useChatThreads,
} from "#/lib/chat-store";
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
			className="rounded bg-background/60 px-1 py-0.5 font-mono text-[0.8125em]"
			{...props}
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
	message: ChatMessage;
}): React.ReactElement {
	const isUser = message.role === "user";
	return (
		<div
			className={cn(
				"flex flex-col gap-1.5",
				isUser ? "items-end" : "items-start",
			)}
		>
			{message.parts.map((part) =>
				part.type === "text" ? (
					<div
						className={cn(
							"max-w-[85%] rounded-2xl px-3 py-1.5 text-sm",
							isUser
								? "bg-primary text-primary-foreground"
								: "bg-muted text-foreground",
						)}
						key={part.id}
					>
						{isUser ? (
							<span className="whitespace-pre-wrap">{part.text}</span>
						) : (
							<ReactMarkdown components={markdownComponents}>
								{part.text}
							</ReactMarkdown>
						)}
					</div>
				) : (
					<div
						className="rounded-md bg-muted/60 px-2 py-1 text-muted-foreground text-xs"
						key={part.id}
					>
						{part.toolName}
					</div>
				),
			)}
		</div>
	);
}

function MessageList({
	messages,
}: {
	messages: readonly ChatMessage[];
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
		<div className="flex flex-col gap-3 px-3 py-3">
			{messages.map((message) => (
				<MessageBubble key={message.id} message={message} />
			))}
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
	const minimized = useChatPopupMinimized(sessionId);
	const dock = useChatDockActions(sessionId);
	const chat = useChatSend(orpc);

	const thread =
		threads.find((candidate) => candidate.id === activeThreadId) ?? null;
	// The strip only renders a popup at all when a thread is active
	// (`chat-dock.tsx`) — this is a defensive fallback for the render in
	// between a thread closing and the store settling on its neighbor, not a
	// reachable steady state.
	if (thread === null) return null;

	return (
		<motion.div
			animate={{ opacity: 1, scale: 1, y: 0 }}
			className="fixed right-4 bottom-14 z-50 flex w-90 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-lg/10"
			exit={{ opacity: 0, scale: 0.96, y: 8 }}
			initial={{ opacity: 0, scale: 0.96, y: 8 }}
			transition={{ duration: 0.15, ease: "easeOut" }}
		>
			<div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
				<span className="truncate font-medium text-sm">{thread.title}</span>
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
						<ScrollArea className="h-80" scrollFade>
							<MessageList messages={thread.messages} />
						</ScrollArea>
						{thread.status === "error" && thread.errorMessage !== null && (
							<p className="border-t px-3 py-2 text-destructive-foreground text-xs">
								{thread.errorMessage}
							</p>
						)}
						<ChatComposer
							key={thread.id}
							onSend={(text, harness, model) =>
								chat.sendMessage(sessionId, thread.id, text, harness, model)
							}
							onStop={() => chat.stopMessage(thread.id)}
							orpc={orpc}
							thread={thread}
						/>
					</motion.div>
				)}
			</AnimatePresence>
		</motion.div>
	);
}
