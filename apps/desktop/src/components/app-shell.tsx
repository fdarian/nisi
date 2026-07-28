"use client";

import { InboxIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { PrTabStrip } from "#/components/pr/pr-tab-strip";
import { PrView } from "#/components/pr/pr-view";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { TabsPrimitive } from "#/components/ui/tabs";
import { useSessions } from "#/lib/pr-data";

/** Top-level shell: the multi-PR tab strip and the active PR's content, both owned by one Tabs.Root so tab activation stays declarative. */
export function AppShell(): React.ReactElement {
	const { sessions, closeSession } = useSessions();
	const [activeSessionId, setActiveSessionId] = useState<string | null>(
		() => sessions[0]?.id ?? null,
	);

	// Base UI's Tabs.Root only *suggests* a fallback value via onValueChange
	// when the active tab disappears from a controlled root — it doesn't pick
	// one for us. So closing the active tab picks its neighbor explicitly,
	// mirroring how browser tab strips behave.
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
			<div className="flex h-screen flex-col">
				<div
					className="h-10 shrink-0 border-b bg-muted/40"
					data-tauri-drag-region
				/>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<InboxIcon />
					</EmptyMedia>
					<EmptyTitle>No open pull requests</EmptyTitle>
					<EmptyDescription>
						Run <code>nisi</code> from a repo to open one.
					</EmptyDescription>
				</Empty>
			</div>
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
						session={session}
					/>
				</TabsPrimitive.Panel>
			))}
		</TabsPrimitive.Root>
	);
}
