"use client";

import { useChat } from "@ai-sdk/react";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import {
	type ChatThreadMeta,
	deriveThreadTitle,
	getOrCreateChat,
} from "#/lib/chat-store";
import { cn } from "#/lib/utils";

type ChatTabProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	thread: ChatThreadMeta;
	isActive: boolean;
	onSelect: () => void;
	onClose: () => void;
};

/**
 * One ghost-button pill per thread in the bottom strip — visual reference:
 * Linear's "Agent" pill. Not built on `Button`/`buttonVariants`: the close
 * affordance nested inside the pill means the pill itself can't be a real
 * `<button>` (no nested interactive elements), so both the select area and
 * the close button are plain elements styled to match ghost-button chrome
 * instead.
 *
 * Calls `useChat` itself, one instance per rendered tab, rather than
 * receiving `title`/`isStreaming` as props — every thread's pill (not just
 * the active one) needs its own live status/title, and `chat-store.ts`
 * doesn't cache either anymore (see its header doc). This is the standard
 * "list of components, each its own hook" shape: legal because each
 * `<ChatTab>` is its own component instance, not a hook called inside the
 * parent's `.map()` callback.
 */
export function ChatTab({
	sessionId,
	orpc,
	thread,
	isActive,
	onSelect,
	onClose,
}: ChatTabProps): React.ReactElement {
	const { messages, status } = useChat({
		chat: getOrCreateChat(orpc, sessionId, thread.id),
	});
	const title = deriveThreadTitle(messages);
	const isStreaming = status === "submitted" || status === "streaming";

	return (
		<div
			className={cn(
				"group flex h-7 shrink-0 items-center rounded-full pr-1 pl-2.5 text-xs transition-colors",
				isActive
					? "bg-accent text-foreground"
					: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
			)}
		>
			<button
				className="flex min-w-0 cursor-pointer items-center gap-1.5"
				onClick={onSelect}
				type="button"
			>
				{isStreaming && (
					<LoaderCircleIcon className="size-3 shrink-0 animate-spin opacity-70" />
				)}
				<span className="max-w-32 truncate">{title}</span>
			</button>
			<button
				aria-label={`Close ${title}`}
				className="ml-1 shrink-0 cursor-pointer rounded-full p-0.5 opacity-0 hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				type="button"
			>
				<XIcon className="size-3" />
			</button>
		</div>
	);
}
