"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLinkIcon, type LucideIcon } from "lucide-react";
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
import type { Session } from "#/lib/pr-data";

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
	 * The active tab's session. Actions that only make sense for a PR (like
	 * opening it on GitHub) are omitted from the list entirely when this is
	 * `null` or its target isn't a `"pr"` — a `nisi diff <base>` session has
	 * no owner/repo/number to link to.
	 */
	activeSession: Session | null;
};

/** Cmd+K, app-wide (`use-command-palette-shortcut.ts`). */
export function CommandPalette({
	open,
	onOpenChange,
	activeSession,
}: CommandPaletteProps): React.ReactElement {
	const [query, setQuery] = useState("");

	useEffect(() => {
		if (!open) return;
		setQuery("");
	}, [open]);

	const actions = buildActions(activeSession);
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

function buildActions(session: Session | null): CommandAction[] {
	if (session === null || session.target.kind !== "pr") return [];
	// `Session`/`SessionTarget` (`pr-data.ts`) carry no `url`; hardcodes
	// github.com — wrong for Enterprise hosts (`packages/git/src/repo-path-mapping.ts:26`).
	const url = `https://github.com/${session.target.owner}/${session.target.repo}/pull/${session.target.number}`;
	return [
		{
			id: "open-pr-in-github",
			label: "Open Pull Request in GitHub",
			icon: ExternalLinkIcon,
			run: () => {
				void openUrl(url);
			},
		},
	];
}
