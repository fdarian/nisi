"use client";

import { AlertTriangleIcon, InboxIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { PrTabStrip } from "#/components/pr/pr-tab-strip";
import { PrView } from "#/components/pr/pr-view";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { FramePanel } from "#/components/ui/frame";
import { Spinner } from "#/components/ui/spinner";
import { TabsPrimitive } from "#/components/ui/tabs";
import { useTabShortcuts } from "#/hooks/use-tab-shortcuts";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useBackendContext } from "#/lib/backend-context";
import { useSessions } from "#/lib/pr-data";

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
 */
const INSET_PANE_CLASS = "m-2 flex min-h-0 flex-1 flex-col overflow-hidden p-0";

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
}: {
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex h-screen flex-col bg-sidebar">
			<div className="h-10 shrink-0" data-tauri-drag-region />
			<FramePanel className={INSET_PANE_CLASS}>{children}</FramePanel>
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
	const { sessions, closeSession } = useSessions(orpc);
	const [requestedActiveSessionId, setRequestedActiveSessionId] = useState<
		string | null
	>(null);

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
			<ShellFrame>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<InboxIcon />
					</EmptyMedia>
					<EmptyTitle>No open pull requests</EmptyTitle>
					<EmptyDescription>
						Run <code>nisi</code> from a repo to open one.
					</EmptyDescription>
				</Empty>
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
		>
			<PrTabStrip onCloseSession={handleCloseSession} sessions={sessions} />
			<FramePanel className={INSET_PANE_CLASS}>
				{sessions.map((session) => (
					<TabsPrimitive.Panel
						className="flex min-h-0 flex-1 flex-col outline-none"
						key={session.id}
						keepMounted
						value={session.id}
					>
						<PrView
							onCloseTab={() => handleCloseSession(session.id)}
							orpc={orpc}
							session={session}
						/>
					</TabsPrimitive.Panel>
				))}
			</FramePanel>
		</TabsPrimitive.Root>
	);
}
