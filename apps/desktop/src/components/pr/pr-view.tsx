"use client";

import { AlertTriangleIcon } from "lucide-react";
import { useMemo } from "react";
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
import {
	useSessionActiveTab,
	useSessionWalkthroughSelection,
} from "#/lib/session-ui-store";
import { useWalkthroughEnabled } from "#/lib/settings-data";

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

	const [walkthroughEnabled] = useWalkthroughEnabled(orpc);
	// Lifted into the per-session UI store (`session-ui-store.ts`), not local
	// `useState` — a suspended tab's `PrView` unmounts entirely
	// (`app-shell.tsx`'s `useTabSuspension`), so this has to live somewhere
	// that survives that to land back on the same sub-tab on resume.
	const [activeTab, setActiveTab] = useSessionActiveTab(session.id);
	// The user can flip `walkthroughEnabled` off while sitting on the
	// Walkthrough tab — its `TabsList`/`TabsContent` stop rendering below, so
	// the value actually handed to `<Tabs>` must fall back to "files"
	// regardless of what `activeTab` state still holds, rather than mutating
	// `activeTab` itself in an effect.
	const tabsValue = walkthroughEnabled ? activeTab : "files";
	// Lifted above the tabs, not local to `WalkthroughView` — a reference/
	// uncovered-file selection should survive switching away to Files Changed
	// and back, not reset every time the Walkthrough tab remounts (and, same
	// as `activeTab` above, survive the whole tab suspending and resuming).
	const [walkthroughSelection, setWalkthroughSelection] =
		useSessionWalkthroughSelection(session.id);

	// Gates the sidecar's 2s worktree poller (`live-poll.ts`) to exactly the
	// sessions someone could actually see a result from — window focused,
	// Files Changed the visible tab, and (since every `PrView` stays mounted,
	// see `isSelectedTab`'s doc comment) this PR's own tab selected, not some
	// other open PR's.
	const windowFocused = useWindowFocused();
	const isFilesChangedVisible = tabsValue === "files" && isSelectedTab;
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
				value={tabsValue}
			>
				{walkthroughEnabled && (
					<WalkthroughTabStrip
						isSelectedTab={isSelectedTab}
						setActiveTab={setActiveTab}
					/>
				)}

				<TabsContent className="flex min-h-0 flex-1 flex-col" value="files">
					{error != null ? (
						<FilesChangedError error={error} />
					) : isLoading ? (
						<FilesChangedLoading />
					) : (
						<FilesChangedView
							files={files}
							hasPendingChanges={hasPendingChanges}
							onRefresh={refreshFileChanges}
							orpc={orpc}
							reviewState={reviewState}
							session={session}
							setViewed={setViewed}
							shortcutsEnabled={isSelectedTab}
						/>
					)}
				</TabsContent>
				{walkthroughEnabled && (
					<TabsContent className="flex min-h-0 flex-1" value="walkthrough">
						<WalkthroughView
							files={files}
							onSelectionChange={setWalkthroughSelection}
							orpc={orpc}
							selection={walkthroughSelection}
							session={session}
						/>
					</TabsContent>
				)}
			</Tabs>
		</div>
	);
}

/**
 * The Walkthrough/Files Changed tab strip, plus the `1`/`2` shortcuts that
 * switch between them — co-located because they're the same feature: when
 * `PrView` doesn't render this component (walkthrough disabled), the
 * `useKeyBindings` listener underneath unmounts along with the tab strip it
 * drives, so `1`/`2` become no-ops in one gate instead of a duplicated
 * `walkthroughEnabled` check on the bindings themselves.
 */
function WalkthroughTabStrip({
	setActiveTab,
	isSelectedTab,
}: {
	setActiveTab: (tab: string) => void;
	isSelectedTab: boolean;
}): React.ReactElement {
	useKeyBindings(
		{
			"1": () => setActiveTab("walkthrough"),
			"2": () => setActiveTab("files"),
		},
		{ enabled: isSelectedTab },
	);

	return (
		<div className="border-b">
			<TabsList className="mx-4" variant="underline">
				<TabsTrigger value="walkthrough">Walkthrough</TabsTrigger>
				<TabsTrigger value="files">Files Changed</TabsTrigger>
			</TabsList>
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
