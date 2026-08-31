"use client";

import { AlertTriangleIcon } from "lucide-react";
import { useMemo } from "react";
import { useDevToolScope } from "#/components/devtool/dev-tool-context";
import { useRefetchToasts } from "#/components/devtool/use-refetch-toasts";
import { FilesChangedView } from "#/components/pr/files-changed-view";
import { OverviewView } from "#/components/pr/overview/overview-view";
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
import type { KeyBindings } from "#/hooks/use-key-bindings";
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
	 * the selected tab. Also factors into `PrHeader`'s `watched` (below), since
	 * the CI ring it hosts is on screen whenever this tab is selected,
	 * regardless of which sub-tab is active. */
	isSelectedTab: boolean;
	onCloseTab: () => void;
};

/** Renders one open PR's content: header + Overview / Walkthrough / Files Changed tabs. */
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
	// Walkthrough tab — its `TabsTrigger`/`TabsContent` stop rendering below,
	// so the value actually handed to `<Tabs>` must fall back to "files"
	// regardless of what `activeTab` state still holds, rather than mutating
	// `activeTab` itself in an effect. "overview"/"files" both stay valid
	// regardless of the setting, so only "walkthrough" ever needs the fallback.
	const tabsValue =
		activeTab === "walkthrough" && !walkthroughEnabled ? "files" : activeTab;
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
	// `PrHeader`'s CI ring is on screen whenever this PR's tab is selected —
	// unlike Files Changed above, it doesn't care which sub-tab is active —
	// see `usePullRequestChecks`'s doc comment (`pr-data.ts`) for how this
	// gates its poll.
	const isHeaderWatched = isSelectedTab && windowFocused;
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

	// Overview and Files Changed always exist regardless of the walkthrough
	// setting; Walkthrough only joins the strip when it's enabled. A single
	// array, not three separately-gated `TabsTrigger`s, is what lets
	// `PrViewTabStrip` derive the `1`/`2`/`3` (or `1`/`2`, walkthrough off)
	// shortcuts from each tab's own index instead of hardcoding which digit
	// means what.
	const tabs = useMemo<readonly PrViewTab[]>(() => {
		const list: PrViewTab[] = [{ value: "overview", label: "Overview" }];
		if (walkthroughEnabled) {
			list.push({ value: "walkthrough", label: "Walkthrough" });
		}
		list.push({ value: "files", label: "Files Changed" });
		return list;
	}, [walkthroughEnabled]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PrHeader
				onCloseTab={onCloseTab}
				orpc={orpc}
				repoRoot={session.repoRoot}
				stat={stat}
				target={session.target}
				watched={isHeaderWatched}
			/>
			<Tabs
				className="flex min-h-0 flex-1 flex-col gap-0"
				onValueChange={(value) => setActiveTab(value as string)}
				value={tabsValue}
			>
				<PrViewTabStrip
					isSelectedTab={isSelectedTab}
					setActiveTab={setActiveTab}
					tabs={tabs}
				/>

				<TabsContent className="flex min-h-0 flex-1" value="overview">
					<OverviewView orpc={orpc} session={session} />
				</TabsContent>
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

type PrViewTab = { value: string; label: string };

/**
 * The Overview/Walkthrough/Files Changed tab strip, plus the digit
 * shortcuts that switch between them — co-located because they're the same
 * feature. Always rendered (unlike the old Walkthrough-only strip this
 * replaced): Overview and Files Changed exist regardless of the walkthrough
 * setting, so there's no longer a "hide the whole strip" case. The digit
 * bound to each tab is just its index in `tabs` (`PrView` builds that array
 * with Walkthrough already included-or-not), so collapsing from three tabs
 * to two never leaves a dead key bound to a tab that isn't showing.
 */
function PrViewTabStrip({
	tabs,
	setActiveTab,
	isSelectedTab,
}: {
	tabs: readonly PrViewTab[];
	setActiveTab: (tab: string) => void;
	isSelectedTab: boolean;
}): React.ReactElement {
	const bindings: KeyBindings = {};
	tabs.forEach((tab, index) => {
		bindings[String(index + 1)] = () => setActiveTab(tab.value);
	});
	useKeyBindings(bindings, { enabled: isSelectedTab });

	return (
		<div className="border-b">
			<TabsList className="mx-4" variant="underline">
				{tabs.map((tab) => (
					<TabsTrigger key={tab.value} value={tab.value}>
						{tab.label}
					</TabsTrigger>
				))}
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
