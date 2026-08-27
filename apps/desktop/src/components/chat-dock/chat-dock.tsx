"use client";

/**
 * The bottom strip: zero height when the active PR has no chat threads,
 * animates open (`motion`) once the first one appears, and reflows the main
 * pane above it since this is a plain sibling of `FramePanel` in the flex
 * column `app-shell.tsx`'s "ready with sessions" branch renders — not an
 * overlay. Mounted once for the whole shell (not per PR tab): switching the
 * active PR tab just changes which session's threads this renders, it never
 * unmounts on its own. See `chat-data.ts`'s doc comment for why that
 * matters — an in-flight turn must survive that kind of incidental
 * re-render.
 */
import { PlusIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback } from "react";
import { ChatPanel } from "#/components/chat-dock/chat-panel";
import { ChatTab } from "#/components/chat-dock/chat-tab";
import { Button } from "#/components/ui/button";
import { useChatShortcut } from "#/hooks/use-chat-shortcut";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useChatSend } from "#/lib/chat-data";
import {
	useChatActiveThreadId,
	useChatDockActions,
	useChatPopupOpen,
	useChatThreads,
} from "#/lib/chat-store";

type ChatDockProps = {
	sessionId: string;
	orpc: SidecarQueryUtils;
};

export function ChatDock({
	sessionId,
	orpc,
}: ChatDockProps): React.ReactElement {
	const threads = useChatThreads(sessionId);
	const activeThreadId = useChatActiveThreadId(sessionId);
	const popupOpen = useChatPopupOpen(sessionId);
	const dock = useChatDockActions(sessionId);
	const chat = useChatSend(orpc);

	// ⌘J: no threads yet starts the first one (which opens the popup on it
	// as a side effect of `openNewThread`); otherwise it's a plain
	// open/closed toggle, the same gesture re-clicking the active tab below
	// performs.
	const handleToggle = useCallback(() => {
		if (threads.length === 0) {
			dock.openNewThread();
			return;
		}
		dock.setPopupOpen(!popupOpen);
	}, [threads.length, popupOpen, dock]);
	useChatShortcut(handleToggle);

	return (
		<>
			<AnimatePresence>
				{popupOpen && (
					<ChatPanel key={sessionId} orpc={orpc} sessionId={sessionId} />
				)}
			</AnimatePresence>
			<motion.div
				animate={{ height: threads.length > 0 ? 40 : 0 }}
				className="flex shrink-0 items-center gap-1.5 overflow-hidden overflow-x-auto border-t px-2"
				initial={false}
				transition={{ duration: 0.15, ease: "easeOut" }}
			>
				{threads.map((thread) => (
					<ChatTab
						isActive={thread.id === activeThreadId && popupOpen}
						key={thread.id}
						onClose={() => chat.closeThread(sessionId, thread.id)}
						onSelect={() => {
							if (thread.id === activeThreadId && popupOpen) {
								dock.setPopupOpen(false);
								return;
							}
							dock.setActiveThread(thread.id);
						}}
						thread={thread}
					/>
				))}
				<Button
					aria-label="New chat"
					onClick={() => dock.openNewThread()}
					size="icon-xs"
					title="New chat"
					variant="ghost"
				>
					<PlusIcon />
				</Button>
			</motion.div>
		</>
	);
}
