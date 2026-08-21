"use client";

import { GitPullRequestIcon, LeafIcon, PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import {
	ContextMenu,
	ContextMenuItem,
	ContextMenuPopup,
	ContextMenuSeparator,
	ContextMenuShortcut,
	ContextMenuTrigger,
} from "#/components/ui/context-menu";
import { Kbd } from "#/components/ui/kbd";
import { TabsPrimitive } from "#/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import { UpdatePill } from "#/components/update-pill";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { Session } from "#/lib/pr-data";
import { cn } from "#/lib/utils";
import { Button } from "../ui/button";

type PrTabStripProps = {
	sessions: readonly Session[];
	/** The tab currently selected in the strip — `PrTab` reads this to keep
	 * its context menu's Suspend item disabled for the active tab, matching
	 * `useTabSuspension`'s own exemption for it. */
	activeSessionId: string | null;
	/** Which open tabs `useTabSuspension` has already idled out — read here
	 * (not by calling the hook itself, which stays owned by `app-shell.tsx`)
	 * to swap in the leaf icon and disable the Suspend item for a tab that's
	 * already suspended. */
	suspendedSessionIds: ReadonlySet<string>;
	onCloseSession: (sessionId: string) => void;
	onCloseOtherSessions: (sessionId: string) => void;
	onOpenPullRequest: () => void;
	/** Suspends one tab immediately, bypassing the idle timeout — bound to
	 * `useTabSuspension`'s `suspendNow` so the context menu's Suspend item
	 * goes through the exact same walkthrough-generation guard and cache
	 * eviction as automatic suspension, rather than a parallel path. */
	onSuspendTab: (sessionId: string) => void;
	/** One-shot check for whether a session has a walkthrough generation
	 * running, bound to `useTabSuspension`'s `isGenerationRunning` — run when
	 * a tab's context menu opens so the Suspend item can disable itself with
	 * that as the shown reason, instead of the click just doing nothing. */
	checkGenerationRunning: (sessionId: string) => Promise<boolean>;
	onContextMenu?: (event: React.MouseEvent) => void;
	/** Threaded through only for `UpdatePill` — the strip itself talks to no other sidecar procedure. */
	orpc: SidecarQueryUtils;
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
	activeSessionId,
	suspendedSessionIds,
	onCloseSession,
	onCloseOtherSessions,
	onOpenPullRequest,
	onSuspendTab,
	checkGenerationRunning,
	onContextMenu,
	orpc,
}: PrTabStripProps): React.ReactElement {
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: right-click only, opens a native OS menu — nothing here needs keyboard/focus semantics.
		<div className="flex shrink-0 pr-2" onContextMenu={onContextMenu}>
			<TrafficLightSpace />
			<TabsPrimitive.List className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-2 items-center">
				{sessions.map((session) => (
					<PrTab
						checkGenerationRunning={checkGenerationRunning}
						hasOtherTabs={sessions.length > 1}
						isActive={session.id === activeSessionId}
						isSuspended={suspendedSessionIds.has(session.id)}
						key={session.id}
						onClose={() => onCloseSession(session.id)}
						onCloseOthers={() => onCloseOtherSessions(session.id)}
						onSuspend={() => onSuspendTab(session.id)}
						session={session}
					/>
				))}
				<OpenPullRequestButton onClick={onOpenPullRequest} />
			</TabsPrimitive.List>
			{/* Outside the scrollable, `flex-1` tab list — that's what keeps the
			 * pill pinned at the strip's right edge instead of scrolling with
			 * the tabs (see this file's top doc comment on why the list gets
			 * `flex-1` in the first place). */}
			<UpdatePill orpc={orpc} />
		</div>
	);
}

/**
 * The ghost "+" that opens the "open pull request" palette
 * (`open-pull-request-palette.tsx`) — a real `<button>` sitting outside
 * `TabsPrimitive.List` as a third child of the strip's own root, matching
 * the close button's own opt-out from the drag region (see this file's top
 * doc comment).
 */
function OpenPullRequestButton({
	onClick,
}: {
	onClick: () => void;
}): React.ReactElement {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label="Open pull request"
						onClick={onClick}
						size="icon-xs"
						variant="ghost"
						type="button"
					>
						<PlusIcon />
					</Button>
				}
			/>
			<TooltipPopup>
				Open pull request <Kbd>⌘T</Kbd>
			</TooltipPopup>
		</Tooltip>
	);
}

/** Why "Suspend" is disabled on the current attempt, shown as the item's own subtext — `null` means it's enabled. */
type SuspendGuard =
	| "active-tab"
	| "already-suspended"
	| "generation-running"
	| null;

const SUSPEND_GUARD_REASON: Record<Exclude<SuspendGuard, null>, string> = {
	"active-tab": "Can't suspend the tab you're viewing",
	"already-suspended": "Already suspended",
	"generation-running": "Walkthrough generation running",
};

function PrTab({
	session,
	isActive,
	isSuspended,
	hasOtherTabs,
	onClose,
	onCloseOthers,
	onSuspend,
	checkGenerationRunning,
}: {
	session: Session;
	isActive: boolean;
	isSuspended: boolean;
	hasOtherTabs: boolean;
	onClose: () => void;
	onCloseOthers: () => void;
	onSuspend: () => void;
	checkGenerationRunning: (sessionId: string) => Promise<boolean>;
}): React.ReactElement {
	const label =
		session.target.kind === "pr"
			? `#${session.target.number} ${session.target.title}`
			: session.target.headRef;

	// Only meaningful while the tab is neither the active one nor already
	// suspended — those two disable "Suspend" on their own, so there's
	// nothing to check the sidecar for. Reset on every open (not just once
	// "running") so a stale "running" read from a previous open doesn't
	// linger after that generation actually finishes.
	const [generationRunning, setGenerationRunning] = useState(false);

	const suspendGuard: SuspendGuard = isActive
		? "active-tab"
		: isSuspended
			? "already-suspended"
			: generationRunning
				? "generation-running"
				: null;

	return (
		<ContextMenu
			onOpenChange={(open) => {
				if (!open) return;
				setGenerationRunning(false);
				if (isActive || isSuspended) return;
				void checkGenerationRunning(session.id).then(setGenerationRunning);
			}}
		>
			<ContextMenuTrigger render={<div className="contents" />}>
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
					{isSuspended ? (
						<LeafIcon className="size-3.5 shrink-0" />
					) : (
						<GitPullRequestIcon className="size-3.5 shrink-0" />
					)}
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
			</ContextMenuTrigger>
			<ContextMenuPopup align="start">
				<ContextMenuItem disabled={suspendGuard !== null} onClick={onSuspend}>
					{suspendGuard === null ? (
						"Suspend"
					) : (
						<div className="flex flex-col gap-0.5 py-0.5">
							<span>Suspend</span>
							<span className="text-muted-foreground text-xs">
								{SUSPEND_GUARD_REASON[suspendGuard]}
							</span>
						</div>
					)}
				</ContextMenuItem>
				<ContextMenuSeparator />
				<ContextMenuItem onClick={onClose}>
					Close
					<ContextMenuShortcut>⌘W</ContextMenuShortcut>
				</ContextMenuItem>
				<ContextMenuItem disabled={!hasOtherTabs} onClick={onCloseOthers}>
					Close other tabs
					<ContextMenuShortcut>⌘⌥W</ContextMenuShortcut>
				</ContextMenuItem>
			</ContextMenuPopup>
		</ContextMenu>
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
