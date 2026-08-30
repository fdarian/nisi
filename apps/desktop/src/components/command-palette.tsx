"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
	CopyIcon,
	ExternalLinkIcon,
	GitPullRequestIcon,
	LayoutDashboardIcon,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
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
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { Session } from "#/lib/pr-data";
import { pullRequestUrl, useSwitchToPr } from "#/lib/pr-data";

type CommandAction = {
	id: string;
	label: string;
	icon: LucideIcon;
	run: () => void;
};

type CommandPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The active tab's session. Every action below is scoped to what this
	 * session's target actually is — `null` (no open tab) offers nothing,
	 * a `"pr"` target offers PR-only actions (like opening it on GitHub), and
	 * a `"branch"` target offers branch-only actions (like switching to the
	 * PR the branch belongs to, once one exists).
	 */
	activeSession: Session | null;
	orpc: SidecarQueryUtils;
	/** Fires once `sessions.open` resolves for "Switch to PR" — mirrors `OpenPullRequestPalette`'s `onSessionOpened` (`app-shell.tsx`), so the new tab activates the same way. */
	onSessionOpened: (sessionId: string) => void;
	/** "Go to Overview" — switches `activeSession`'s own sub-tab (`pr-view.tsx`'s `PrViewTabStrip`), same store `app-shell.tsx` reads via `useSessionActiveTab`. */
	onNavigateToTab: (tab: string) => void;
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

	useEffect(() => {
		if (!open) return;
		setQuery("");
	}, [open]);

	const { switchToPr } = useSwitchToPr(orpc, onSessionOpened);
	const actions = buildActions(activeSession, switchToPr, onNavigateToTab);
	const filtered = actions.filter((action) =>
		action.label.toLowerCase().includes(query.toLowerCase()),
	);

	return (
		<CommandDialog onOpenChange={onOpenChange} open={open}>
			<CommandDialogPopup>
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
		action.run();
		onOpenChange(false);
	}
}

function buildActions(
	session: Session | null,
	switchToPr: (repoRoot: string) => void,
	onNavigateToTab: (tab: string) => void,
): CommandAction[] {
	if (session === null) return [];
	const actions: CommandAction[] = [
		{
			id: "go-to-overview",
			label: "Go to Overview",
			icon: LayoutDashboardIcon,
			run: () => onNavigateToTab("overview"),
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
				void openUrl(url);
			},
		});
	} else {
		const repoRoot = session.repoRoot;
		actions.push({
			id: "switch-to-pr",
			label: "Switch to PR",
			icon: GitPullRequestIcon,
			run: () => {
				switchToPr(repoRoot);
			},
		});
	}
	return actions;
}
