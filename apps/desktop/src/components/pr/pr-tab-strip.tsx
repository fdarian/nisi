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
 *
 * That region is `"deep"`, not bare: Tauri's drag script (`drag.js` in the
 * `tauri` crate) treats a bare `data-tauri-drag-region` as *this element
 * only* — `el === composedPath[0]` — and the `Tabs.List` below stretches
 * (`flex-1`) across all the empty space right of the last tab, so every click
 * out there lands on the list, not on this div, and used to do nothing.
 * `"deep"` makes the whole subtree draggable instead. Interactive descendants
 * still opt out on their own: that same script bails on anything with a
 * clickable tag or role, which covers both the tabs (`role="tab"`) and their
 * close `<button>`s — nothing here needs an explicit `="false"`.
 */
export function PrTabStrip({
	sessions,
	onCloseSession,
}: PrTabStripProps): React.ReactElement {
	return (
		<div className="flex shrink-0 pr-2">
			<TrafficLightSpace />
			<TabsPrimitive.List className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-2">
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
				"group relative flex min-w-32 max-w-56 shrink cursor-pointer items-center gap-1.5 self-end rounded-md px-2.5 py-1.5 text-muted-foreground text-xs outline-none",
				"bg-pane-surface hover:bg-background hover:text-foreground",
				"before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
				"data-active:bg-background data-active:text-foreground data-active:bg-clip-padding data-active:shadow-xs/5",
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

/**
 * Dummy for trafficlight placement. Remove the `opacity-0` to preview
 */
function TrafficLightSpace() {
	return (
		<div className="flex shrink-0 items-center gap-[8.9px] px-3 opacity-0">
			{["#FF5F57", "#FEBC2E", "#28C840"].map((color) => (
				<span
					className="size-3.5 rounded-full"
					key={color}
					style={{ background: color }}
				/>
			))}
		</div>
	);
}
