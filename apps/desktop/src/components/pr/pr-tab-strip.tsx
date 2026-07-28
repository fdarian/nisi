"use client";

import { GitPullRequestIcon, XIcon } from "lucide-react";
import { TabsPrimitive } from "#/components/ui/tabs";
import type { Session } from "#/lib/pr-data";
import { cn } from "#/lib/utils";

type PrTabStripProps = {
	sessions: readonly Session[];
	onCloseSession: (sessionId: string) => void;
};

/**
 * Browser/Linear-style closable tabs, one per open PR. Renders as a child of
 * the `TabsPrimitive.Root` that also owns the PR panels below (see
 * `app-shell.tsx`) so activation stays declarative.
 *
 * The window uses a macOS overlay titlebar with `hiddenTitle: true` — no
 * native title bar remains to drag by, and the traffic lights float over the
 * top-left corner — so the strip reserves space for them and marks its own
 * background (not the tabs themselves) as a Tauri drag region.
 */
export function PrTabStrip({
	sessions,
	onCloseSession,
}: PrTabStripProps): React.ReactElement {
	return (
		<div
			className="flex h-10 shrink-0 items-stretch border-b bg-muted/40 pr-2 pl-[78px]"
			data-tauri-drag-region
		>
			<TabsPrimitive.List className="flex min-w-0 flex-1 items-stretch gap-1 overflow-x-auto">
				{sessions.map((session) => (
					<PrTab
						key={session.id}
						onClose={() => onCloseSession(session.id)}
						session={session}
					/>
				))}
			</TabsPrimitive.List>
		</div>
	);
}

function PrTab({
	session,
	onClose,
}: {
	session: Session;
	onClose: () => void;
}): React.ReactElement {
	const label = session.pr
		? `#${session.pr.number} ${session.pr.title}`
		: session.repoRoot;

	return (
		<TabsPrimitive.Tab
			className={cn(
				"group relative flex min-w-32 max-w-56 shrink cursor-pointer items-center gap-1.5 self-end rounded-t-md px-2.5 py-1.5 text-muted-foreground text-xs outline-none",
				"hover:bg-background/60",
				"data-active:bg-background data-active:text-foreground",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
			)}
			nativeButton={false}
			render={<div />}
			value={session.id}
		>
			<GitPullRequestIcon className="size-3.5 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			<button
				aria-label="Close tab"
				className="shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 group-data-active:opacity-100"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				type="button"
			>
				<XIcon className="size-3" />
			</button>
		</TabsPrimitive.Tab>
	);
}
