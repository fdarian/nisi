"use client";

/**
 * The bottom strip: zero height when the active PR has no chat threads,
 * animates open (`motion`) once the first one appears, and reflows the main
 * pane above it since this is a plain sibling of `FramePanel` in the flex
 * column `app-shell.tsx`'s "ready with sessions" branch renders — not an
 * overlay. Mounted once for the whole shell (not per PR tab): switching the
 * active PR tab just changes which session's threads this renders, it never
 * unmounts on its own. See `chat-store.ts`'s header doc comment for why
 * that matters — a thread's `Chat` instance (and any turn it's mid-stream
 * on) must survive that kind of incidental re-render.
 *
 * `mx-2` mirrors `FramePanel`'s own `m-2` (`app-shell.tsx`'s
 * `INSET_PANE_CLASS`) so the strip's left/right edges line up with the
 * card's rather than running full-bleed to the window edge past its rounded
 * corners — a plain sibling with its own margin, not a child of
 * `FramePanel`, is enough to read as "part of the surface" once it shares
 * that inset and drops the heavy `border-t` a full-width divider would put
 * against the page background (the pills are ghost buttons; they don't
 * need one).
 */
import { PlusIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback } from "react";
import { ChatPanel } from "#/components/chat-dock/chat-panel";
import { ChatTab } from "#/components/chat-dock/chat-tab";
import { Button } from "#/components/ui/button";
import { useChatShortcut } from "#/hooks/use-chat-shortcut";
import type { SidecarQueryUtils } from "#/lib/backend-context";
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
	const dock = useChatDockActions(sessionId, orpc);

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
				// `marginBottom` animates in lockstep with `height` rather than
				// sitting in `className` as a static `mb-2` — a static bottom
				// margin would still reserve 8px of dead space at the window edge
				// even while the strip is collapsed to zero height (flex siblings'
				// margins don't collapse into each other the way block siblings'
				// do). `mx-2` has no such phantom-space problem (it never adds
				// height), so it stays a plain class.
				animate={{
					height: threads.length > 0 ? 40 : 0,
					marginBottom: threads.length > 0 ? 8 : 0,
				}}
				className="mx-2 flex shrink-0 items-center gap-1.5 overflow-hidden overflow-x-auto px-2"
				initial={false}
				transition={{ duration: 0.15, ease: "easeOut" }}
			>
				{threads.map((thread) => (
					<ChatTab
						isActive={thread.id === activeThreadId && popupOpen}
						key={thread.id}
						onClose={() => dock.closeThread(thread.id)}
						onSelect={() => {
							if (thread.id === activeThreadId && popupOpen) {
								dock.setPopupOpen(false);
								return;
							}
							dock.setActiveThread(thread.id);
						}}
						orpc={orpc}
						sessionId={sessionId}
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
