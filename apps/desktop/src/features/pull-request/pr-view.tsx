"use client";

import { useMemo } from "react";
import { Tabs, TabsContent } from "#/components/ui/tabs";
import { useDevToolScope } from "#/features/devtools/dev-tool-context";
import { useRefetchToasts } from "#/features/devtools/use-refetch-toasts";
import type { Session } from "#/features/pull-request/data/pr-data";
import {
	useFileChanges,
	useLiveFileChanges,
	usePullRequestAttention,
	useRefreshOnWatchedEdge,
	useReviewState,
	useSessionWatch,
	useSetFileViewed,
} from "#/features/pull-request/data/pr-data";
import type { OpenPullRequestParams } from "#/features/pull-request/data/pull-requests-data";
import {
	fileTabId,
	useSessionActiveTab,
	useSessionOpenFiles,
	useSessionWalkthroughSelection,
} from "#/features/pull-request/data/session-ui-store";
import { GuideView } from "#/features/guide/guide-view";
import { guideExists, useGuide } from "#/features/guide/use-guide";
import { FileView } from "#/features/pull-request/file-view/file-view";
import { FilesChangedContent } from "#/features/pull-request/files/files-changed-content";
import { diffStat } from "#/features/pull-request/header/diff-stat";
import { PrHeader } from "#/features/pull-request/header/pr-header";
import { useNavigationShortcuts } from "#/features/pull-request/navigation/use-navigation-shortcuts";
import { useOpenInGitHubShortcut } from "#/features/pull-request/navigation/use-open-in-github-shortcut";
import { OverviewView } from "#/features/pull-request/overview/overview-view";
import { WalkthroughView } from "#/features/pull-request/walkthrough/walkthrough-view";
import { useWalkthroughEnabled } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useLaunchMark } from "#/infra/launch-trace";
import { useWindowFocused } from "#/infra/use-window-focused";
import { CiLogProvider } from "./ci-log/ci-log-provider";
import {
	PR_VIEW_TABS_CLASS,
	PrViewTabStrip,
	prViewTabs,
} from "./pr-view-tab-strip";

type PrViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	/** Whether this PR's tab is the one currently selected in the multi-PR tab strip —
	 * every `PrView` stays mounted (`app-shell.tsx`'s `TabsPrimitive.Panel` keeps
	 * `keepMounted`), so this is what tells an inactive one apart from the active
	 * one. Gates both the sidecar watch below and every keyboard shortcut here —
	 * and everything threaded down to `FilesChangedView`/`FilesSidebar` — to only
	 * the selected tab. Also factors into `PrHeader`'s `watched` (below), since
	 * the CI ring it hosts is on screen whenever this tab is selected,
	 * regardless of which sub-tab is active. */
	isSelectedTab: boolean;
	onCloseTab: () => void;
	findExistingSessionId: (params: OpenPullRequestParams) => string | undefined;
	onSessionOpened: (sessionId: string) => void;
};

/** Renders one open PR's content: header + Overview / Walkthrough / Files Changed tabs. */
export function PrView({
	session,
	orpc,
	isSelectedTab,
	onCloseTab,
	findExistingSessionId,
	onSessionOpened,
}: PrViewProps): React.ReactElement {
	const fileChanges = useFileChanges(orpc, session.id);
	const files = fileChanges.files;
	const isLoading = fileChanges.isLoading;
	const error = fileChanges.error;
	const reviewState = useReviewState(orpc, files);
	const setViewed = useSetFileViewed(orpc, session.id);
	const {
		hasPendingChanges,
		isRefreshing: isRefreshingBase,
		refresh: refreshFileChanges,
	} = useLiveFileChanges(orpc, session.id);

	const [walkthroughEnabled] = useWalkthroughEnabled(orpc);
	// Lifted into the per-session UI store (`session-ui-store.ts`), not local
	// `useState` — a suspended tab's `PrView` unmounts entirely
	// (`app-shell.tsx`'s `useTabSuspension`), so this has to live somewhere
	// that survives that to land back on the same sub-tab on resume.
	const [activeTab, setActiveTab] = useSessionActiveTab(session.id);
	const guide = useGuide(
		orpc,
		session.id,
		isSelectedTab && activeTab === "guide",
	);
	const hasGuide = guideExists(guide.data);
	// The user can flip `walkthroughEnabled` off while sitting on the
	// Walkthrough tab — its `TabsTrigger`/`TabsContent` stop rendering below,
	// so the value actually handed to `<Tabs>` must fall back to "files"
	// regardless of what `activeTab` state still holds, rather than mutating
	// `activeTab` itself in an effect. The same goes for Guide when its file
	// is deleted. "overview"/"files" stay valid either way.
	const tabIsAbsent =
		(activeTab === "walkthrough" && !walkthroughEnabled) ||
		(activeTab === "guide" && !hasGuide);
	const tabsValue = tabIsAbsent ? "files" : activeTab;
	// Lifted above the tabs, not local to `WalkthroughView` — a reference/
	// uncovered-file selection should survive switching away to Files Changed
	// and back, not reset every time the Walkthrough tab remounts (and, same
	// as `activeTab` above, survive the whole tab suspending and resuming).
	const [walkthroughSelection, setWalkthroughSelection] =
		useSessionWalkthroughSelection(session.id);
	// The dynamic file-viewer tabs (`file-view.tsx`) rendered after the static
	// ones in `PrViewTabStrip` — see `SessionUiState.openFiles`'s doc comment.
	const { openFiles, openFile, closeFile } = useSessionOpenFiles(session.id);
	const filePaths = useMemo(
		() => new Set(files.map((file) => file.path)),
		[files],
	);
	useNavigationShortcuts({
		enabled: isSelectedTab,
		filePaths,
		openFiles,
		sessionId: session.id,
	});
	useOpenInGitHubShortcut({ enabled: isSelectedTab, session });

	// Gates the sidecar's 2s worktree poller (`live-poll.ts`) to exactly the
	// sessions someone could actually see a result from — window focused,
	// Files Changed the visible tab, and (since every `PrView` stays mounted,
	// see `isSelectedTab`'s doc comment) this PR's own tab selected, not some
	// other open PR's.
	const windowFocused = useWindowFocused();
	const isFilesChangedVisible = tabsValue === "files" && isSelectedTab;
	useLaunchMark("pr-view.mounted", {
		when: isSelectedTab,
		sessionId: session.id,
	});
	useLaunchMark("diff.files.resolved", {
		when: !isLoading && error == null,
		sessionId: session.id,
	});
	useLaunchMark("files.list.painted", {
		when: isFilesChangedVisible && !isLoading && error == null,
		tab: files.length === 0 ? "files" : undefined,
		sessionId: session.id,
	});
	const watched = isFilesChangedVisible && windowFocused;
	useSessionWatch(orpc, session.id, watched);
	// The same `watched` rising edge doubles as the refetch trigger for
	// switching into this tab and regaining window focus — see
	// `useRefreshOnWatchedEdge`'s doc comment (`pr-data.ts`).
	useRefreshOnWatchedEdge(watched, refreshFileChanges);
	// `PrHeader`'s CI ring is on screen whenever this PR's tab is selected —
	// unlike Files Changed above, it doesn't care which sub-tab is active —
	// see `usePullRequestChecks`'s doc comment (`pr-data.ts`) for how this
	// gates its poll.
	const isHeaderWatched = isSelectedTab && windowFocused;
	usePullRequestAttention(orpc, session.id, isHeaderWatched);
	// Not gated on window focus — the devtool popover should offer the
	// "toast on every refetch" option whenever Files Changed is the visible
	// tab, whether or not the window currently has focus.
	useDevToolScope("files-changed", isFilesChangedVisible);
	useRefetchToasts(orpc, session.id);

	const stat = diffStat({ files, isLoading, error });

	const tabs = useMemo(
		() => prViewTabs({ walkthroughEnabled, guideExists: hasGuide }),
		[walkthroughEnabled, hasGuide],
	);

	return (
		<CiLogProvider session={session} orpc={orpc} active={isSelectedTab}>
			<div className="flex min-h-0 flex-1 flex-col">
				<PrHeader
					isSelectedTab={isSelectedTab}
					onCloseTab={onCloseTab}
					orpc={orpc}
					repoRoot={session.repoRoot}
					stat={stat}
					baseMayBeStale={fileChanges.baseMayBeStale === true}
					isRetryingBase={isRefreshingBase}
					onRetryBase={refreshFileChanges}
					target={session.target}
					watched={isHeaderWatched}
					findExistingSessionId={findExistingSessionId}
					onSessionOpened={onSessionOpened}
				/>
				<Tabs
					className={PR_VIEW_TABS_CLASS}
					onValueChange={(value) => setActiveTab(value as string)}
					value={tabsValue}
				>
					<PrViewTabStrip
						orpc={orpc}
						session={session}
						activeTab={activeTab}
						isSelectedTab={isSelectedTab}
						onCloseFile={closeFile}
						openFiles={openFiles}
						setActiveTab={setActiveTab}
						tabs={tabs}
					/>

					<TabsContent className="flex min-h-0 flex-1" value="overview">
						<OverviewView
							enabled={isSelectedTab && tabsValue === "overview"}
							orpc={orpc}
							session={session}
						/>
					</TabsContent>
					<TabsContent className="flex min-h-0 flex-1 flex-col" value="files">
						<FilesChangedContent
							isLoading={isLoading}
							error={error}
							files={files}
							hasPendingChanges={hasPendingChanges}
							onOpenFile={openFile}
							onRefresh={refreshFileChanges}
							orpc={orpc}
							reviewState={reviewState}
							session={session}
							setViewed={setViewed}
							shortcutsEnabled={isSelectedTab}
							isVisible={isFilesChangedVisible}
						/>
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
					{hasGuide && (
						<TabsContent className="flex min-h-0 flex-1" value="guide">
							<GuideView
								enabled={isSelectedTab && tabsValue === "guide"}
								orpc={orpc}
								session={session}
							/>
						</TabsContent>
					)}
					{openFiles.map((path) => (
						<TabsContent
							className="flex min-h-0 flex-1 flex-col"
							key={path}
							value={fileTabId(path)}
						>
							<FileView orpc={orpc} path={path} sessionId={session.id} />
						</TabsContent>
					))}
				</Tabs>
			</div>
		</CiLogProvider>
	);
}
