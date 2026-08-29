"use client";

import { useChat } from "@ai-sdk/react";
import { LoaderCircleIcon, XIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
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
 * Linear's "Agent" pill. The close affordance is a *sibling* of that pill,
 * absolutely positioned over its right edge rather than nested inside it:
 * a button inside a button is invalid HTML, and overlaying instead of
 * reserving space keeps the pill from resizing on hover (pills that reflow
 * under the cursor are hard to aim at). Being siblings is also what makes
 * closing a thread never also select it — the click lands on the close
 * button alone, with nothing underneath to bubble into.
 *
 * The title fades out *under* that overlay, which is a mask on the text
 * rather than a gradient painted in the pill's own colour: `--accent` and
 * `--background` are both translucent tokens, so a gradient overlay would
 * read as a second tint stacked on the pill instead of matching it. The
 * `max(50%, …)` floor keeps a short title from dissolving entirely, since
 * the fade is measured from the text's own right edge, not the pill's.
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
		<div className="group relative shrink-0 flex">
			<Button
				className={cn(
					"text-xs before:rounded-full",
					isActive
						? "bg-accent text-foreground"
						: "text-muted-foreground hover:text-foreground",
				)}
				onClick={onSelect}
				size="xs"
				variant="ghost"
			>
				{isStreaming && <LoaderCircleIcon className="size-3 animate-spin" />}
				<span className="max-w-32 truncate group-focus:mask-r-from-[calc(100%-2.25rem)] group-focus:mask-r-to-[calc(100%-0.75rem)] group-hover:mask-r-from-[calc(100%-2.25rem)] group-hover:mask-r-to-[calc(100%-0.75rem)]">
					{title}
				</span>
			</Button>

			<Button
				aria-label={`Close ${title}`}
				className="-translate-y-1/2 absolute top-1/2 right-0.5 rounded-full opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
				onClick={onClose}
				size="icon-2xs"
				variant="link"
			>
				<XIcon />
			</Button>
		</div>
	);
}
