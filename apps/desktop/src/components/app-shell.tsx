"use client";

import { Menu } from "@tauri-apps/api/menu";
import { AlertTriangleIcon, InboxIcon } from "lucide-react";
import { type ComponentProps, useCallback, useMemo, useState } from "react";
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
import { useTabShortcuts } from "#/hooks/use-tab-shortcuts";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useBackendContext } from "#/lib/backend-context";
import { useSessions } from "#/lib/pr-data";
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

	return <AppShellReady orpc={backend.orpc} />;
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
	const { sessions, closeSession } = useSessions(
		orpc,
		setRequestedActiveSessionId,
	);
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

	// Base UI's Tabs.Root only *suggests* a fallback value via onValueChange
	// when the active tab disappears from a controlled root — it doesn't pick
	// one for us. Closing the active tab picks its neighbor explicitly,
	// mirroring how browser tab strips behave.
	const handleCloseSession = useCallback(
		(sessionId: string) => {
			closeSession(sessionId);
			if (activeSessionId !== sessionId) return;
			const index = sessions.findIndex((session) => session.id === sessionId);
			const neighbor = sessions[index + 1] ?? sessions[index - 1];
			setRequestedActiveSessionId(neighbor?.id ?? null);
		},
		[activeSessionId, closeSession, sessions],
	);

	const sessionIds = useMemo(
		() => sessions.map((session) => session.id),
		[sessions],
	);
	useTabShortcuts({
		activeTabId: activeSessionId,
		onActivateTab: setRequestedActiveSessionId,
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
					open={commandPaletteOpen}
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
				onCloseSession={handleCloseSession}
				onOpenPullRequest={openPalette}
				sessions={sessions}
			/>
			<FramePanel className={cn(INSET_PANE_CLASS, "mt-0")}>
				{sessions.map((session) => (
					<TabsPrimitive.Panel
						className="flex min-h-0 flex-1 flex-col outline-none"
						key={session.id}
						keepMounted
						value={session.id}
					>
						<PrView
							// `keepMounted` above means every open PR tab's `PrView` stays
							// mounted at once — this is what tells the visible tab apart
							// from a background one, both for the sidecar watch gating
							// below and for keyboard shortcuts (`j`/`k`/`r`/`u`, `1`/`2`),
							// which must only be live for whichever tab is selected.
							isSelectedTab={session.id === activeSessionId}
							onCloseTab={() => handleCloseSession(session.id)}
							orpc={orpc}
							session={session}
						/>
					</TabsPrimitive.Panel>
				))}
			</FramePanel>
			<DevTool />
			<OpenPullRequestPalette
				onOpenChange={setPaletteOpen}
				onSessionOpened={setRequestedActiveSessionId}
				open={paletteOpen}
				orpc={orpc}
			/>
			<CommandPalette
				activeSession={activeSession}
				onOpenChange={setCommandPaletteOpen}
				open={commandPaletteOpen}
			/>
		</TabsPrimitive.Root>
	);
}

function DevTool() {
	const [devToolVisible] = useDevToolVisible();

	return import.meta.env.DEV === true || devToolVisible ? (
		<div className="absolute -bottom-1 left-3">
			<DevToolButton />
		</div>
	) : null;
}
