"use client";

import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	restrictToHorizontalAxis,
	restrictToParentElement,
} from "@dnd-kit/modifiers";
import {
	arrayMove,
	horizontalListSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GitPullRequestIcon, LeafIcon, PlusIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
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
	/** Persists a drag-reorder. Ids are the strip's visual order after the drop. */
	onReorderSessions: (sessionIds: readonly string[]) => void;
	/** Activates the dragged tab on pickup, matching browser tab strips. */
	onActivateSession: (sessionId: string) => void;
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
 *
 * Reorder uses dnd-kit's sortable preset (same method as Dice UI's Sortable):
 * `DndContext` + `SortableContext` + `useSortable`, horizontal list strategy,
 * closest-center collision, axis/parent modifiers, and a `DragOverlay` so the
 * moving tab isn't clipped by the list's `overflow-x-auto`. The sortable node
 * is a real wrapper around the tab — `ContextMenuTrigger`'s `display: contents`
 * parent has a zero box, which made `restrictToParentElement` lock leftward
 * drags and sent the overlay's drop animation to `(0, 0)`. Mouse activation
 * waits 8px so a click still selects the tab.
 */
export function PrTabStrip({
	sessions,
	activeSessionId,
	suspendedSessionIds,
	onCloseSession,
	onCloseOtherSessions,
	onOpenPullRequest,
	onReorderSessions,
	onActivateSession,
	onSuspendTab,
	checkGenerationRunning,
	onContextMenu,
	orpc,
}: PrTabStripProps): React.ReactElement {
	const [draggingId, setDraggingId] = useState<string | null>(null);
	const sessionIds = useMemo(
		() => sessions.map((session) => session.id),
		[sessions],
	);
	const sensors = useSensors(
		useSensor(MouseSensor, {
			activationConstraint: { distance: 8 },
		}),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const draggingSession =
		draggingId === null
			? undefined
			: sessions.find((session) => session.id === draggingId);

	function handleDragStart(event: DragStartEvent) {
		const sessionId = String(event.active.id);
		setDraggingId(sessionId);
		onActivateSession(sessionId);
	}

	function handleDragEnd(event: DragEndEvent) {
		setDraggingId(null);
		if (event.over == null) return;
		const activeId = String(event.active.id);
		const overId = String(event.over.id);
		if (activeId === overId) return;
		const oldIndex = sessionIds.indexOf(activeId);
		const newIndex = sessionIds.indexOf(overId);
		if (oldIndex < 0 || newIndex < 0) return;
		onReorderSessions(arrayMove([...sessionIds], oldIndex, newIndex));
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: right-click only, opens a native OS menu — nothing here needs keyboard/focus semantics.
		<div className="flex shrink-0 pr-2" onContextMenu={onContextMenu}>
			<TrafficLightSpace />
			<DndContext
				collisionDetection={closestCenter}
				modifiers={[restrictToHorizontalAxis, restrictToParentElement]}
				onDragCancel={() => setDraggingId(null)}
				onDragEnd={handleDragEnd}
				onDragStart={handleDragStart}
				sensors={sensors}
			>
				<SortableContext
					items={sessionIds}
					strategy={horizontalListSortingStrategy}
				>
					<TabsPrimitive.List className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-2">
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
				</SortableContext>
				<DragOverlay dropAnimation={null}>
					{draggingSession === undefined ? null : (
						<PrTabPreview
							isSuspended={suspendedSessionIds.has(draggingSession.id)}
							session={draggingSession}
						/>
					)}
				</DragOverlay>
			</DndContext>
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

function sessionLabel(session: Session): string {
	return session.target.kind === "pr"
		? `#${session.target.number} ${session.target.title}`
		: session.target.headRef;
}

const PR_TAB_CLASS = cn(
	"group relative flex min-w-32 max-w-56 shrink select-none items-center gap-1.5 self-end rounded-md px-2.5 py-1.5 text-muted-foreground text-xs outline-none",
	"bg-pane-surface hover:bg-background hover:text-foreground",
	"before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-md)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
	"data-active:bg-background data-active:text-foreground data-active:bg-clip-padding data-active:shadow-xs/5",
	"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
);

function PrTabIcon({
	isSuspended,
}: {
	isSuspended: boolean;
}): React.ReactElement {
	return isSuspended ? (
		<LeafIcon className="size-3.5 shrink-0" />
	) : (
		<GitPullRequestIcon className="size-3.5 shrink-0" />
	);
}

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
	const sortable = useSortable({
		id: session.id,
		disabled: !hasOtherTabs,
	});

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
		<div
			className={cn("shrink self-end", sortable.isDragging && "opacity-0")}
			ref={sortable.setNodeRef}
			style={{
				transform: CSS.Translate.toString(sortable.transform),
				transition: sortable.transition,
			}}
			{...sortable.listeners}
		>
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
							PR_TAB_CLASS,
							hasOtherTabs ? "cursor-grab" : "cursor-pointer",
							sortable.isDragging && "cursor-grabbing",
						)}
						nativeButton={false}
						render={<div />}
						value={session.id}
					>
						<PrTabIcon isSuspended={isSuspended} />
						<span className="min-w-0 flex-1 truncate">
							{sessionLabel(session)}
						</span>
						<button
							aria-label="Close tab"
							className="shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover:opacity-100 group-data-active:opacity-100"
							onClick={(event) => {
								event.stopPropagation();
								onClose();
							}}
							onPointerDown={(event) => {
								event.stopPropagation();
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
		</div>
	);
}

/** Presentational clone for `DragOverlay` — must not call `useSortable`. */
function PrTabPreview({
	session,
	isSuspended,
}: {
	session: Session;
	isSuspended: boolean;
}): React.ReactElement {
	return (
		<div
			className={cn(
				PR_TAB_CLASS,
				"cursor-grabbing bg-background text-foreground shadow-xs/5",
			)}
			data-tauri-drag-region="false"
		>
			<PrTabIcon isSuspended={isSuspended} />
			<span className="min-w-0 flex-1 truncate">{sessionLabel(session)}</span>
			<span className="size-4 shrink-0" />
		</div>
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
