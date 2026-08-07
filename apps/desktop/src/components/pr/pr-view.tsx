"use client";

import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useDevToolScope } from "#/components/devtool/dev-tool-context";
import { useRefetchToasts } from "#/components/devtool/use-refetch-toasts";
import { FilesChangedView } from "#/components/pr/files-changed-view";
import { PrHeader } from "#/components/pr/pr-header";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { WalkthroughView } from "#/components/walkthrough/walkthrough-view";
import { useKeyBindings } from "#/hooks/use-key-bindings";
import { useWindowFocused } from "#/hooks/use-window-focused";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { Session } from "#/lib/pr-data";
import {
	useFileChanges,
	useLiveFileChanges,
	useRefreshOnWatchedEdge,
	useReviewState,
	useSessionWatch,
	useSetFileViewed,
} from "#/lib/pr-data";

type PrViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	/** Whether this PR's tab is the one currently selected in the multi-PR tab strip —
	 * every `PrView` stays mounted (`app-shell.tsx`'s `TabsPrimitive.Panel` keeps
	 * `keepMounted`), so this is what tells an inactive one apart from the active
	 * one. Gates both the sidecar watch below and every keyboard shortcut here —
	 * and everything threaded down to `FilesChangedView`/`FilesSidebar` — to only
	 * the selected tab. */
	isSelectedTab: boolean;
	onCloseTab: () => void;
};

/** Renders one open PR's content: header + Files Changed / Walkthrough / Commits tabs. */
export function PrView({
	session,
	orpc,
	isSelectedTab,
	onCloseTab,
}: PrViewProps): React.ReactElement {
	const { files, isLoading, error } = useFileChanges(orpc, session.id);
	const reviewState = useReviewState(orpc, files);
	const setViewed = useSetFileViewed(orpc, session.id);
	const { hasPendingChanges, refresh: refreshFileChanges } = useLiveFileChanges(
		orpc,
		session.id,
	);

	// Lifted above both tabs' content — a "reviewed in `<block>`" marker
	// clicked from Files Changed needs to both select a block in the
	// Walkthrough tab and switch to it, and `Tabs` here is the one thing both
	// live under.
	const [activeTab, setActiveTab] = useState("files");
	const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

	// Gates the sidecar's 2s worktree poller (`live-poll.ts`) to exactly the
	// sessions someone could actually see a result from — window focused,
	// Files Changed the visible tab, and (since every `PrView` stays mounted,
	// see `isSelectedTab`'s doc comment) this PR's own tab selected, not some
	// other open PR's.
	const windowFocused = useWindowFocused();
	const isFilesChangedVisible = activeTab === "files" && isSelectedTab;
	const watched = isFilesChangedVisible && windowFocused;
	useSessionWatch(orpc, session.id, watched);
	// The same `watched` rising edge doubles as the refetch trigger for
	// switching into this tab and regaining window focus — see
	// `useRefreshOnWatchedEdge`'s doc comment (`pr-data.ts`).
	useRefreshOnWatchedEdge(watched, refreshFileChanges);
	// Not gated on window focus — the devtool popover should offer the
	// "toast on every refetch" option whenever Files Changed is the visible
	// tab, whether or not the window currently has focus.
	useDevToolScope("files-changed", isFilesChangedVisible);
	useRefetchToasts(orpc, session.id);
	const handleNavigateToBlock = useCallback((blockId: string) => {
		setSelectedBlockId(blockId);
		setActiveTab("walkthrough");
	}, []);

	useKeyBindings(
		{
			"1": () => setActiveTab("walkthrough"),
			"2": () => setActiveTab("files"),
		},
		{ enabled: isSelectedTab },
	);

	const stat = useMemo(
		() =>
			files.reduce(
				(totals, file) => ({
					additions: totals.additions + file.additions,
					deletions: totals.deletions + file.deletions,
				}),
				{ additions: 0, deletions: 0 },
			),
		[files],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PrHeader
				onCloseTab={onCloseTab}
				orpc={orpc}
				repoRoot={session.repoRoot}
				stat={stat}
				target={session.target}
			/>
			<Tabs
				className="flex min-h-0 flex-1 flex-col gap-0"
				onValueChange={(value) => setActiveTab(value as string)}
				value={activeTab}
			>
				<div className="border-b">
					<TabsList className="mx-4" variant="underline">
						<TabsTrigger value="walkthrough">Walkthrough</TabsTrigger>
						<TabsTrigger value="files">Files Changed</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent className="flex min-h-0 flex-1 flex-col" value="files">
					{error != null ? (
						<FilesChangedError error={error} />
					) : isLoading ? (
						<FilesChangedLoading />
					) : (
						<FilesChangedView
							files={files}
							hasPendingChanges={hasPendingChanges}
							onNavigateToBlock={handleNavigateToBlock}
							onRefresh={refreshFileChanges}
							orpc={orpc}
							reviewState={reviewState}
							session={session}
							setViewed={setViewed}
							shortcutsEnabled={isSelectedTab}
						/>
					)}
				</TabsContent>
				<TabsContent className="flex min-h-0 flex-1" value="walkthrough">
					<WalkthroughView
						files={files}
						onSelectBlock={setSelectedBlockId}
						orpc={orpc}
						selectedBlockId={selectedBlockId}
						session={session}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}

function FilesChangedLoading(): React.ReactElement {
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<Spinner className="size-5" />
			</EmptyMedia>
			<EmptyTitle>Loading changed files…</EmptyTitle>
		</Empty>
	);
}

function FilesChangedError({ error }: { error: unknown }): React.ReactElement {
	const message = error instanceof Error ? error.message : String(error);
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<AlertTriangleIcon />
			</EmptyMedia>
			<EmptyTitle>Couldn't load changed files</EmptyTitle>
			<EmptyDescription>{message}</EmptyDescription>
		</Empty>
	);
}
