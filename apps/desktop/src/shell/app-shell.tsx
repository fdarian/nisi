"use client";

import { Menu } from "@tauri-apps/api/menu";
import { cn } from "cn";
import { AlertTriangleIcon, InboxIcon } from "lucide-react";
import {
	type ComponentProps,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
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
import { ChatDock } from "#/features/chat/chat-dock";
import {
	ChatProvider,
	useChatPopupMinimized,
	useChatPopupOpen,
	useClearChatSession,
	useCycleActiveThread,
} from "#/features/chat/chat-store";
import { CommandPalette } from "#/features/command-palette/command-palette";
import { OpenPullRequestPalette } from "#/features/command-palette/open-pull-request-palette";
import { useCommandPaletteShortcut } from "#/features/command-palette/use-command-palette-shortcut";
import { useOpenPrPaletteShortcut } from "#/features/command-palette/use-open-pr-palette-shortcut";
import { DevToolButton } from "#/features/devtools/dev-tool";
import { useDevToolVisible } from "#/features/devtools/dev-tool-context";
import { useSessions } from "#/features/pull-request/data/pr-data";
import type { OpenPullRequestParams } from "#/features/pull-request/data/pull-requests-data";
import { findOpenPullRequestSessionId } from "#/features/pull-request/data/pull-requests-data";
import {
	SessionUiProvider,
	useClearSessionUiState,
	useCycleFileTab,
	useSetActiveTab,
} from "#/features/pull-request/data/session-ui-store";
import { PrView } from "#/features/pull-request/pr-view";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { useDeepLinkOpener } from "./deep-link/deep-link-data";
import { useOpenRequest } from "./open-request/open-request-data";
import { PrTabStrip } from "./tabs/pr-tab-strip";
import { useTabOrder } from "./tabs/use-tab-order";
import { useTabShortcuts } from "./tabs/use-tab-shortcuts";
import { useTabSuspension } from "./tabs/use-tab-suspension";

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
	const [userTabSelection, setUserTabSelection] = useState<{
		requestId: string;
		sessionId: string;
	} | null>(null);
	const listed = useSessions(orpc, setRequestedActiveSessionId);
	const open = useOpenRequest();
	const request = open.request;
	const pendingRequest = request?.status.kind === "opened" ? null : request;
	const pendingTabId =
		pendingRequest === null ? null : `open:${pendingRequest.id}`;
	const selectSession = useCallback(
		(sessionId: string) => {
			setRequestedActiveSessionId(sessionId);
			if (request !== null) {
				setUserTabSelection({ requestId: request.id, sessionId });
			}
		},
		[request],
	);
	// Hooks run before the `sessions.length === 0` early return below, so a
	// cold start into the empty state (nothing open yet) still opens a
	// pending deep link instead of stalling on it.
	useDeepLinkOpener(orpc, setRequestedActiveSessionId);
	const tabOrder = useTabOrder(listed.sessions);
	const sessions = tabOrder.orderedSessions;
	const findExistingSessionId = useCallback(
		(params: OpenPullRequestParams) =>
			findOpenPullRequestSessionId(sessions, params),
		[sessions],
	);
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
			request !== null &&
			userTabSelection?.requestId === request.id &&
			sessions.some((session) => session.id === userTabSelection.sessionId)
		) {
			return userTabSelection.sessionId;
		}
		const openedId =
			request?.status.kind === "opened" ? request.status.session.id : null;
		if (
			openedId !== null &&
			sessions.some((session) => session.id === openedId)
		) {
			return openedId;
		}
		if (
			requestedActiveSessionId != null &&
			sessions.some((session) => session.id === requestedActiveSessionId)
		) {
			return requestedActiveSessionId;
		}
		return sessions[0]?.id ?? null;
	}, [requestedActiveSessionId, sessions, request, userTabSelection]);
	const selectedTabId =
		pendingRequest !== null && userTabSelection?.requestId === pendingRequest.id
			? userTabSelection.sessionId
			: (pendingTabId ?? activeSessionId);
	const selectedSessionId =
		selectedTabId === pendingTabId ? null : selectedTabId;
	useEffect(() => {
		if (request?.status.kind !== "opened") return;
		const openedId = request.status.session.id;
		if (!sessions.some((session) => session.id === openedId)) return;
		if (userTabSelection?.requestId !== request.id) {
			setRequestedActiveSessionId(openedId);
		}
		open.acknowledge(request.id);
	}, [request, sessions, userTabSelection, open.acknowledge]);

	const activeSession = useMemo(
		() => sessions.find((session) => session.id === selectedSessionId) ?? null,
		[sessions, selectedSessionId],
	);
	// The command palette's "Go to Overview" action needs to switch a
	// specific session's own sub-tab — the same per-session store `PrView`
	// itself reads/writes, just the raw two-arg action rather than one bound
	// to a single session, since `CommandPalette` already has the session id
	// in hand (`activeSession.id`) at the moment it calls this.
	const setActiveTab = useSetActiveTab();

	// Which open tabs have gone idle long enough to unmount, plus the manual
	// trigger and generation check `PrTabStrip`'s per-tab context menu needs
	// — see `useTabSuspension`'s doc comment for the full policy (never the
	// active tab, never one with a walkthrough generation running).
	// `suspendedSessionIds` is read back below to gate each session's
	// `TabsPrimitive.Panel`'s own `keepMounted`.
	const tabSuspension = useTabSuspension(sessions, selectedSessionId, orpc);

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
			if (selectedSessionId !== sessionId) return;
			const index = sessions.findIndex((session) => session.id === sessionId);
			const neighbor = sessions[index + 1] ?? sessions[index - 1];
			setRequestedActiveSessionId(neighbor?.id ?? null);
		},
		[
			selectedSessionId,
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
	// The active session's chat popup gets first refusal on ⌘⇧]/⌘⇧[ — see
	// `useTabShortcuts`'s `onChatThreadShortcut` doc comment.
	const activeChatPopupOpen = useChatPopupOpen(selectedSessionId);
	const activeChatPopupMinimized = useChatPopupMinimized(selectedSessionId);
	const cycleActiveThread = useCycleActiveThread();
	const cycleFileTab = useCycleFileTab();
	const handleChatThreadShortcut = useCallback(
		(direction: "next" | "previous"): boolean => {
			if (selectedSessionId === null) return false;
			if (!activeChatPopupOpen || activeChatPopupMinimized) return false;
			cycleActiveThread(selectedSessionId, direction);
			return true;
		},
		[
			selectedSessionId,
			activeChatPopupOpen,
			activeChatPopupMinimized,
			cycleActiveThread,
		],
	);
	const handleFullFileTabShortcut = useCallback(
		(direction: "next" | "previous"): boolean => {
			if (selectedSessionId === null) return false;
			return cycleFileTab(selectedSessionId, direction);
		},
		[selectedSessionId, cycleFileTab],
	);
	useTabShortcuts({
		activeTabId: selectedSessionId,
		onActivateTab: selectSession,
		onChatThreadShortcut: handleChatThreadShortcut,
		onFullFileTabShortcut: handleFullFileTabShortcut,
		onCloseOtherTabs: handleCloseOtherSessions,
		onCloseTab: handleCloseSession,
		tabIds: sessionIds,
	});

	if (sessions.length === 0 && pendingRequest === null) {
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
					findExistingSessionId={findExistingSessionId}
					onOpenChange={setPaletteOpen}
					onSessionOpened={setRequestedActiveSessionId}
					open={paletteOpen}
					orpc={orpc}
				/>
				<CommandPalette
					activeSession={activeSession}
					onNavigateToTab={setActiveTab}
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
			onValueChange={(value) => {
				if (value === pendingTabId) {
					setUserTabSelection(null);
				} else if (typeof value === "string") {
					selectSession(value);
				}
			}}
			value={selectedTabId}
			data-tauri-drag-region="deep"
			onContextMenu={handleTabStripContextMenu}
		>
			<PrTabStrip
				pendingRequest={pendingRequest}
				activeSessionId={selectedSessionId}
				checkGenerationRunning={tabSuspension.isGenerationRunning}
				onActivateSession={selectSession}
				onCloseOtherSessions={handleCloseOtherSessions}
				onCloseSession={handleCloseSession}
				onOpenPullRequest={openPalette}
				onReorderSessions={tabOrder.reorder}
				onSuspendTab={tabSuspension.suspendNow}
				orpc={orpc}
				sessions={sessions}
				suspendedSessionIds={tabSuspension.suspendedSessionIds}
			/>
			<FramePanel
				className={cn(INSET_PANE_CLASS, "my-0")}
				data-tauri-drag-region="false"
			>
				{pendingRequest !== null && pendingTabId !== null && (
					<TabsPrimitive.Panel
						className="flex flex-1 flex-col items-center justify-center gap-3 p-6"
						value={pendingTabId}
					>
						{pendingRequest.status.kind === "pending" ? (
							<>
								<Spinner className="size-5" />
								<p>Opening {pendingRequest.cwd}…</p>
							</>
						) : pendingRequest.status.kind === "failed" ? (
							<>
								<p>Couldn’t open {pendingRequest.cwd}</p>
								<p className="text-muted-foreground text-sm">
									{pendingRequest.status.message}
								</p>
								<Button
									onClick={() => open.acknowledge(pendingRequest.id)}
									size="sm"
								>
									Dismiss
								</Button>
							</>
						) : null}
					</TabsPrimitive.Panel>
				)}
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
							isSelectedTab={session.id === selectedTabId}
							onCloseTab={() => handleCloseSession(session.id)}
							findExistingSessionId={findExistingSessionId}
							onSessionOpened={setRequestedActiveSessionId}
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
				findExistingSessionId={findExistingSessionId}
				onOpenChange={setPaletteOpen}
				onSessionOpened={setRequestedActiveSessionId}
				open={paletteOpen}
				orpc={orpc}
			/>
			<CommandPalette
				activeSession={activeSession}
				onNavigateToTab={setActiveTab}
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
