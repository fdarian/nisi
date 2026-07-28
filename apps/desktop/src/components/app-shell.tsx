"use client";

import { AlertTriangleIcon, InboxIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PrTabStrip } from "#/components/pr/pr-tab-strip";
import { PrView } from "#/components/pr/pr-view";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { TabsPrimitive } from "#/components/ui/tabs";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useBackendContext } from "#/lib/backend-context";
import { useSessions } from "#/lib/pr-data";

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
		<div className="flex h-screen flex-col">
			<div
				className="h-10 shrink-0 border-b bg-muted/40"
				data-tauri-drag-region
			/>
			{children}
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
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

	// Keeps the active tab valid as `sessions` changes for any reason — our
	// own close, the CLI opening a session out from under us, or an idle tab
	// closing elsewhere (both arrive via `events.subscribe`, see `pr-data.ts`).
	useEffect(() => {
		setActiveSessionId((current) => {
			if (
				current != null &&
				sessions.some((session) => session.id === current)
			) {
				return current;
			}
			return sessions[0]?.id ?? null;
		});
	}, [sessions]);

	// Base UI's Tabs.Root only *suggests* a fallback value via onValueChange
	// when the active tab disappears from a controlled root — it doesn't pick
	// one for us. Closing the active tab picks its neighbor explicitly,
	// mirroring how browser tab strips behave (the effect above still fires,
	// but agrees with this pick since the neighbor is already valid).
	const handleCloseSession = useCallback(
		(sessionId: string) => {
			closeSession(sessionId);
			setActiveSessionId((current) => {
				if (current !== sessionId) return current;
				const index = sessions.findIndex((session) => session.id === sessionId);
				const neighbor = sessions[index + 1] ?? sessions[index - 1];
				return neighbor?.id ?? null;
			});
		},
		[closeSession, sessions],
	);

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
			className="flex h-screen flex-col"
			onValueChange={(value) => setActiveSessionId(value as string | null)}
			value={activeSessionId}
		>
			<PrTabStrip onCloseSession={handleCloseSession} sessions={sessions} />
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
		</TabsPrimitive.Root>
	);
}
