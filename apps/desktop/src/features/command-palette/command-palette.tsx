"use client";

import {
	CopyIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	LayoutDashboardIcon,
	type LucideIcon,
	MessageSquareIcon,
	MessageSquarePlusIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandFooter,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPanel,
} from "#/components/ui/command";
import { Kbd } from "#/components/ui/kbd";
import { Separator } from "#/components/ui/separator";
import {
	type ChatThreadMeta,
	deriveThreadTitle,
	getOrCreateChat,
	useChatThreads,
	useFocusChatThread,
	useStartNewChat,
} from "#/features/chat/chat-store";
import type { Session } from "#/features/pull-request/data/pr-data";
import {
	pullRequestUrl,
	useSwitchToPr,
} from "#/features/pull-request/data/pr-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { native } from "#/infra/native";

type CommandAction = {
	id: string;
	label: string;
	icon: LucideIcon;
	run: () => void;
	/** The action moves focus somewhere itself (e.g. a chat composer), so closing the palette must not restore focus to what had it before. */
	keepsFocus?: true;
};

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The active tab's session. Every action below is scoped to what this
	 * session's target actually is — `null` (no open tab) offers nothing,
	 * a `"pr"` target offers PR-only actions (like opening it on GitHub), and
	 * a `"branch"` target offers branch-only actions (like switching to the
	 * PR the branch belongs to, once one exists). Its chat threads are listed
	 * too, plus "Start new chat".
	 */
	activeSession: Session | null;
	orpc: SidecarQueryUtils;
	/** Fires once `sessions.switchToPr` resolves for "Switch to PR" — mirrors `OpenPullRequestPalette`'s `onSessionOpened` (`app-shell.tsx`), so the active tab follows whichever session id the sidecar answered with. */
	onSessionOpened: (sessionId: string) => void;
	/** "Go to Overview" — switches a session's own sub-tab (`pr-view.tsx`'s `PrViewTabStrip`), same store `app-shell.tsx` writes to via `useSetActiveTab`. */
	onNavigateToTab: (sessionId: string, tab: string) => void;
};

/** Cmd+K, app-wide (`use-command-palette-shortcut.ts`). */
export function CommandPalette({
	open,
	onOpenChange,
	activeSession,
	orpc,
	onSessionOpened,
	onNavigateToTab,
}: CommandPaletteProps): React.ReactElement {
	const [query, setQuery] = useState("");
	const restoreFocusOnClose = useRef(true);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		restoreFocusOnClose.current = true;
	}, [open]);

	const { switchToPr } = useSwitchToPr(orpc, onSessionOpened);
	const activeSessionId = activeSession === null ? null : activeSession.id;
	const threads = useChatThreads(activeSessionId);
	const focusChatThread = useFocusChatThread();
	const startNewChat = useStartNewChat();
	const actions = buildActions({
		session: activeSession,
		orpc,
		threads,
		switchToPr,
		onNavigateToTab,
		focusChatThread,
		startNewChat,
	});
	const filtered = actions.filter((action) =>
		action.label.toLowerCase().includes(query.toLowerCase()),
	);

	return (
		<CommandDialog onOpenChange={onOpenChange} open={open}>
			{/* Base UI's default restores focus to whatever had it before the palette opened, which would pull the caret back out of the chat composer a tick after a chat action focuses it — same hazard as `diff-selection-popover.tsx`'s `finalFocus={false}`. */}
			<CommandDialogPopup finalFocus={() => restoreFocusOnClose.current}>
				<CommandPanel>
					<Command
						filter={null}
						items={filtered}
						onValueChange={setQuery}
						value={query}
					>
						<CommandInput placeholder="Type a command…" />
						<Separator />
						<CommandEmpty>No matching commands.</CommandEmpty>
						<CommandList>
							{(action: CommandAction) => (
								<CommandItem
									key={action.id}
									onClick={() => handleSelect(action)}
									value={action}
								>
									<div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
										<action.icon className="size-4 shrink-0 text-muted-foreground" />
										{action.label}
									</div>
								</CommandItem>
							)}
						</CommandList>
					</Command>
				</CommandPanel>
				<CommandFooter>
					<span className="flex items-center gap-1.5">
						<Kbd>↵</Kbd> Run
					</span>
				</CommandFooter>
			</CommandDialogPopup>
		</CommandDialog>
	);

	function handleSelect(action: CommandAction) {
		restoreFocusOnClose.current = action.keepsFocus !== true;
		action.run();
		onOpenChange(false);
	}
}

function buildActions(params: {
	session: Session | null;
	orpc: SidecarQueryUtils;
	threads: readonly ChatThreadMeta[];
	switchToPr: (sessionId: string) => void;
	onNavigateToTab: (sessionId: string, tab: string) => void;
	focusChatThread: (sessionId: string, threadId: string) => void;
	startNewChat: (sessionId: string) => void;
}): CommandAction[] {
	const session = params.session;
	if (session === null) return [];
	const actions: CommandAction[] = [
		{
			id: "go-to-overview",
			label: "Go to Overview",
			icon: LayoutDashboardIcon,
			run: () => params.onNavigateToTab(session.id, "overview"),
		},
		{
			id: "copy-branch-name",
			label: "Copy branch name",
			icon: CopyIcon,
			run: () => {
				void navigator.clipboard.writeText(session.target.headRef);
			},
		},
	];
	if (session.target.kind === "pr") {
		const url = pullRequestUrl(session.target);
		actions.push({
			id: "open-pr-in-github",
			label: "Open Pull Request in GitHub",
			icon: ExternalLinkIcon,
			run: () => {
				void native().openUrl(url);
			},
		});
	} else {
		const sessionId = session.id;
		actions.push({
			id: "switch-to-pr",
			label: "Switch to PR",
			icon: GitPullRequestIcon,
			run: () => {
				params.switchToPr(sessionId);
			},
		});
	}
	actions.push({
		id: "start-new-chat",
		label: "Start new chat",
		icon: MessageSquarePlusIcon,
		keepsFocus: true,
		run: () => params.startNewChat(session.id),
	});
	for (const thread of params.threads) {
		const title = deriveThreadTitle(
			getOrCreateChat(params.orpc, session.id, thread.id).messages,
		);
		actions.push({
			id: `chat-thread-${thread.id}`,
			label: `Chat: ${title}`,
			icon: MessageSquareIcon,
			keepsFocus: true,
			run: () => params.focusChatThread(session.id, thread.id),
		});
	}
	return actions;
}
