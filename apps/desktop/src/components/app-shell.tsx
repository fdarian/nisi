"use client";

import { Menu } from "@tauri-apps/api/menu";
import { AlertTriangleIcon, InboxIcon } from "lucide-react";
import { type ComponentProps, useCallback, useMemo, useState } from "react";
import { ChatDock } from "#/components/chat-dock/chat-dock";
import { CommandPalette } from "#/components/command-palette";
import { DevToolButton } from "#/components/devtool/dev-tool";
import { useDevToolVisible } from "#/components/devtool/dev-tool-context";
import { OpenPullRequestPalette } from "#/components/pr/open-pull-request-palette";
import { PrTabStrip } from "#/components/pr/pr-tab-strip";
import { PrView } from "#/components/pr/pr-view";
import { Button } from "#/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { FramePanel } from "#/components/ui/frame";
import { Spinner } from "#/components/ui/spinner";
import { TabsPrimitive } from "#/components/ui/tabs";
import { useCommandPaletteShortcut } from "#/hooks/use-command-palette-shortcut";
import { useOpenPrPaletteShortcut } from "#/hooks/use-open-pr-palette-shortcut";
import { useTabOrder } from "#/hooks/use-tab-order";
import { useTabShortcuts } from "#/hooks/use-tab-shortcuts";
import { useTabSuspension } from "#/hooks/use-tab-suspension";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useBackendContext } from "#/lib/backend-context";
import { ChatProvider, useClearChatSession } from "#/lib/chat-store";
import { useSessions } from "#/lib/pr-data";
import {
	SessionUiProvider,
	useClearSessionUiState,
} from "#/lib/session-ui-store";
import { cn } from "#/lib/utils";

/**
 * Mirrors `SidebarInset`'s inset treatment (`ui/sidebar.tsx`, used as-is by
 * `SettingsPage`'s route) — `m-2 rounded-xl shadow-sm/5 bg-background` — but
 * applied directly rather than through the `Sidebar`/`SidebarProvider`
 * machinery, which assumes a collapsible left rail `AppShell` doesn't have
 * (its own `FilesSidebar` is a plain flex child, not that system). The outer
 * `bg-sidebar` on both call sites is what makes the gap read as a gap.
 *
 * Layered onto `FramePanel` (`ui/frame.tsx`, the vendored coss ui recipe)
 * rather than a plain `div` so the pane also picks up its hairline `border`
 * and refined `shadow-xs/5` edge — `p-0` overrides `FramePanel`'s own `p-5`
 * via `cn`'s `twMerge`, since this pane manages its own children's padding.
 *
 * The surface is declared as `--pane-surface` in `index.css` and consumed by
 * `bg-pane-surface` here so descendants can reach the exact tone they sit on
 * — the diff pane's cards need it to paint the corners of a pinned file
 * header, and they can't derive it, since `background` doesn't inherit
 * (`diffCardChromeCSS`).
 */
const INSET_PANE_CLASS =
	"m-2 flex min-h-0 flex-1 flex-col overflow-hidden bg-pane-surface p-0";

/** Top-level shell: gates on the sidecar connection, then renders the multi-PR tab strip. */
export function AppShell(): React.ReactElement {
	const backend = useBackendContext();

	if (backend.status === "loading") {
		return (
			<ShellFrame>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<Spinner className="size-5" />
					</EmptyMedia>
					<EmptyTitle>Connecting to sidecar…</EmptyTitle>
				</Empty>
			</ShellFrame>
		);
	}

	if (backend.status === "error") {
		return (
			<ShellFrame>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<AlertTriangleIcon />
					</EmptyMedia>
					<EmptyTitle>Couldn't reach the sidecar</EmptyTitle>
					<EmptyDescription>{backend.message}</EmptyDescription>
				</Empty>
			</ShellFrame>
		);
	}

	return (
		<SessionUiProvider>
			<ChatProvider>
				<AppShellReady orpc={backend.orpc} />
			</ChatProvider>
		</SessionUiProvider>
	);
}

function ShellFrame({
	children,
	...rest
}: {
	children: React.ReactNode;
	onContextMenu?: ComponentProps<"div">["onContextMenu"];
}): React.ReactElement {
	return (
		<div className="flex h-screen flex-col bg-sidebar" {...rest}>
			<div className="h-10 shrink-0" data-tauri-drag-region />
			<FramePanel className={INSET_PANE_CLASS}>{children}</FramePanel>

			<DevTool />
		</div>
	);
}

/**
 * Renders the multi-PR tab strip and the active PR's content, both owned by
 * one `Tabs.Root` so tab activation stays declarative.
 */
function AppShellReady({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const [requestedActiveSessionId, setRequestedActiveSessionId] = useState<
		string | null
	>(null);
	const listed = useSessions(orpc, setRequestedActiveSessionId);
	const tabOrder = useTabOrder(listed.sessions);
	const sessions = tabOrder.orderedSessions;
	const closeSession = listed.closeSession;
	const [paletteOpen, setPaletteOpen] = useState(false);
	const openPalette = useCallback(() => setPaletteOpen(true), []);
	useOpenPrPaletteShortcut(openPalette);

	const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
	const openCommandPalette = useCallback(() => setCommandPaletteOpen(true), []);
	useCommandPaletteShortcut(openCommandPalette);

	const [devToolVisible, setDevToolVisible] = useDevToolVisible();
	const handleTabStripContextMenu = useCallback(
		async (event: React.MouseEvent) => {
			event.preventDefault();
			const menu = await Menu.new({
				items: [
					{
						id: "toggle-devtool",
						text: devToolVisible ? "Hide DevTool" : "Enable DevTool",
						action: () => setDevToolVisible(!devToolVisible),
					},
				],
			});
			await menu.popup();
		},
		[devToolVisible, setDevToolVisible],
	);

	// Falls back to the first session whenever the requested id no longer
	// matches any open session — our own close, the CLI opening a session out
	// from under us, or an idle tab closing elsewhere (both arrive via
	// `events.subscribe`, see `pr-data.ts`). Derived at render time rather
	// than corrected in an effect, so `TabsPrimitive.Root` never commits a
	// `value` with no matching `Panel` — an effect only runs after paint,
	// which would blank the content pane for a frame first.
	const activeSessionId = useMemo(() => {
		if (
			requestedActiveSessionId != null &&
			sessions.some((session) => session.id === requestedActiveSessionId)
		) {
			return requestedActiveSessionId;
		}
		return sessions[0]?.id ?? null;
	}, [requestedActiveSessionId, sessions]);

	const activeSession = useMemo(
		() => sessions.find((session) => session.id === activeSessionId) ?? null,
		[sessions, activeSessionId],
	);

	// Which open tabs have gone idle long enough to unmount, plus the manual
	// trigger and generation check `PrTabStrip`'s per-tab context menu needs
	// — see `useTabSuspension`'s doc comment for the full policy (never the
	// active tab, never one with a walkthrough generation running).
	// `suspendedSessionIds` is read back below to gate each session's
	// `TabsPrimitive.Panel`'s own `keepMounted`.
	const tabSuspension = useTabSuspension(sessions, activeSessionId, orpc);

	// Base UI's Tabs.Root only *suggests* a fallback value via onValueChange
	// when the active tab disappears from a controlled root — it doesn't pick
	// one for us. Closing the active tab picks its neighbor explicitly,
	// mirroring how browser tab strips behave.
	const clearSessionUiState = useClearSessionUiState();
	// Chat threads are already disposed server-side when their owning PR
	// session closes (the sidecar walks its own reverse index) — this just
	// drops the frontend's now-stale copy of them, same reasoning as
	// `clearSessionUiState` below.
	const clearChatSession = useClearChatSession();
	const handleCloseSession = useCallback(
		(sessionId: string) => {
			closeSession(sessionId);
			// The per-tab UI state store (`session-ui-store.ts`) has no other
			// signal for "this tab is gone for good" — suspension leaves it
			// intact on purpose, so only an actual close should drop it.
			clearSessionUiState(sessionId);
			clearChatSession(sessionId);
			if (activeSessionId !== sessionId) return;
			const index = sessions.findIndex((session) => session.id === sessionId);
			const neighbor = sessions[index + 1] ?? sessions[index - 1];
			setRequestedActiveSessionId(neighbor?.id ?? null);
		},
		[
			activeSessionId,
			closeSession,
			clearSessionUiState,
			clearChatSession,
			sessions,
		],
	);

	const handleCloseOtherSessions = useCallback(
		(sessionId: string) => {
			for (const session of sessions) {
				if (session.id === sessionId) continue;
				closeSession(session.id);
				clearSessionUiState(session.id);
			}
			setRequestedActiveSessionId(sessionId);
		},
		[sessions, closeSession, clearSessionUiState],
	);

	const sessionIds = useMemo(
		() => sessions.map((session) => session.id),
		[sessions],
	);
	useTabShortcuts({
		activeTabId: activeSessionId,
		onActivateTab: setRequestedActiveSessionId,
		onCloseOtherTabs: handleCloseOtherSessions,
		onCloseTab: handleCloseSession,
		tabIds: sessionIds,
	});

	if (sessions.length === 0) {
		return (
			<ShellFrame onContextMenu={handleTabStripContextMenu}>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<InboxIcon />
					</EmptyMedia>
					<EmptyTitle>No open pull requests</EmptyTitle>
					<EmptyDescription>
						Run <code>nisi</code> from a repo to open one, or pick one from your
						open pull requests.
					</EmptyDescription>
					<EmptyContent>
						<Button onClick={openPalette} size="sm">
							Open pull request
						</Button>
					</EmptyContent>
				</Empty>
				<OpenPullRequestPalette
					onOpenChange={setPaletteOpen}
					onSessionOpened={setRequestedActiveSessionId}
					open={paletteOpen}
					orpc={orpc}
				/>
				<CommandPalette
					activeSession={activeSession}
					onOpenChange={setCommandPaletteOpen}
					onSessionOpened={setRequestedActiveSessionId}
					open={commandPaletteOpen}
					orpc={orpc}
				/>
			</ShellFrame>
		);
	}

	return (
		<TabsPrimitive.Root
			className="flex h-screen flex-col bg-sidebar"
			onValueChange={(value) =>
				setRequestedActiveSessionId(value as string | null)
			}
			value={activeSessionId}
			data-tauri-drag-region="deep"
			onContextMenu={handleTabStripContextMenu}
		>
			<PrTabStrip
				activeSessionId={activeSessionId}
				checkGenerationRunning={tabSuspension.isGenerationRunning}
				onActivateSession={setRequestedActiveSessionId}
				onCloseOtherSessions={handleCloseOtherSessions}
				onCloseSession={handleCloseSession}
				onOpenPullRequest={openPalette}
				onReorderSessions={tabOrder.reorder}
				onSuspendTab={tabSuspension.suspendNow}
				orpc={orpc}
				sessions={sessions}
				suspendedSessionIds={tabSuspension.suspendedSessionIds}
			/>
			<FramePanel className={cn(INSET_PANE_CLASS, "my-0")}>
				{sessions.map((session) => (
					<TabsPrimitive.Panel
						className="flex min-h-0 flex-1 flex-col outline-none"
						key={session.id}
						// Every open PR tab's `PrView` stays mounted while its tab isn't
						// suspended — this (not `isSelectedTab` below) is what tells a
						// background-but-still-warm tab apart from one idle long enough
						// to have unmounted (`useTabSuspension`). Dropping `keepMounted`
						// for a suspended session lets Base UI's own "not the open
						// panel" behavior actually unmount it — see that hook's doc
						// comment for why that's safe: this panel's internal `mounted`
						// state already went false shortly after the tab was last
						// deselected, well before the suspend timer fires.
						keepMounted={!tabSuspension.suspendedSessionIds.has(session.id)}
						value={session.id}
					>
						<PrView
							// `isSelectedTab` (not `keepMounted` above) is what tells the
							// visible tab apart from a background one for the sidecar
							// watch gating below and for keyboard shortcuts
							// (`j`/`k`/`r`/`u`, `1`/`2`), which must only be live for
							// whichever tab is selected.
							isSelectedTab={session.id === activeSessionId}
							onCloseTab={() => handleCloseSession(session.id)}
							orpc={orpc}
							session={session}
						/>
					</TabsPrimitive.Panel>
				))}
			</FramePanel>

			<div className="relative flex min-h-2 items-center">
				<DevTool />

				<div className="grow" />

				{activeSessionId !== null && (
					<ChatDock orpc={orpc} sessionId={activeSessionId} />
				)}
			</div>

			<OpenPullRequestPalette
				onOpenChange={setPaletteOpen}
				onSessionOpened={setRequestedActiveSessionId}
				open={paletteOpen}
				orpc={orpc}
			/>
			<CommandPalette
				activeSession={activeSession}
				onOpenChange={setCommandPaletteOpen}
				onSessionOpened={setRequestedActiveSessionId}
				open={commandPaletteOpen}
				orpc={orpc}
			/>
		</TabsPrimitive.Root>
	);
}

function DevTool() {
	const [devToolVisible] = useDevToolVisible();

	return import.meta.env.DEV === true || devToolVisible ? (
		<DevToolButton />
	) : null;
}
