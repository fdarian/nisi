"use client";

import { AlertTriangleIcon, XIcon } from "lucide-react";
import { useMemo } from "react";
import { useDevToolScope } from "#/components/devtool/dev-tool-context";
import { useRefetchToasts } from "#/components/devtool/use-refetch-toasts";
import { FileView } from "#/components/pr/file-view";
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
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsPrimitive,
	TabsTrigger,
} from "#/components/ui/tabs";
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
	fileTabId,
	useSessionActiveTab,
	useSessionOpenFiles,
	useSessionWalkthroughSelection,
} from "#/lib/session-ui-store";
import { useWalkthroughEnabled } from "#/lib/settings-data";
import { splitPath } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

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
	// The dynamic file-viewer tabs (`file-view.tsx`) rendered after the static
	// ones in `PrViewTabStrip` — see `SessionUiState.openFiles`'s doc comment.
	const { openFiles, closeFile } = useSessionOpenFiles(session.id);

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
				sessionId={session.id}
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
					onCloseFile={closeFile}
					openFiles={openFiles}
					setActiveTab={setActiveTab}
					tabs={tabs}
				/>

				<TabsContent className="flex min-h-0 flex-1" value="overview">
					<OverviewView
						orpc={orpc}
						session={session}
						watched={isHeaderWatched}
					/>
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
 * to two never leaves a dead key bound to a tab that isn't showing — file
 * tabs (below) deliberately aren't part of this binding, so opening/closing
 * one never shifts what `1`/`2`/`3` mean.
 *
 * `openFiles` renders as a second block after a vertical divider, inside
 * the *same* `TabsList`/`Tabs.Root` as the static tabs — not a separate one
 * — so `TabsList`'s shared `Tabs.Indicator` (the underline, `variant="underline"`)
 * keeps tracking whichever tab is actually active for free: the moment a
 * file tab is selected, the indicator moves off the static tabs onto it,
 * which *is* "the static tabs lose their underline." Each file tab layers
 * its own rounded filled-pill active state on top via `data-active:` classes
 * instead of relying on that thin underline to read as "selected."
 */
function PrViewTabStrip({
	tabs,
	openFiles,
	setActiveTab,
	onCloseFile,
	isSelectedTab,
}: {
	tabs: readonly PrViewTab[];
	openFiles: readonly string[];
	setActiveTab: (tab: string) => void;
	onCloseFile: (path: string) => void;
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
				{openFiles.length > 0 && (
					<div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
				)}
				{openFiles.map((path) => (
					<FileViewerTab
						key={path}
						onClose={() => onCloseFile(path)}
						path={path}
					/>
				))}
			</TabsList>
		</div>
	);
}

/**
 * One open file's tab — deliberately not the shared `TabsTrigger`
 * (`#/components/ui/tabs`, styled for the underline variant's plain
 * text-color active state): the design calls for a rounded filled pill
 * instead, so this renders the underlying `TabsPrimitive.Tab` directly with
 * its own classes, mirroring `pr-tab-strip.tsx`'s `PrTab` for the
 * hover-reveal close button (`nativeButton={false}`/`render={<div />}` so
 * the close `<button>` can nest inside without a button-in-button).
 */
function FileViewerTab({
	path,
	onClose,
}: {
	path: string;
	onClose: () => void;
}): React.ReactElement {
	const { basename } = splitPath(path);
	return (
		<TabsPrimitive.Tab
			className={cn(
				"group relative flex h-7 shrink-0 select-none items-center gap-1.5 self-center rounded-full px-3 font-medium text-muted-foreground text-xs outline-none",
				"hover:bg-accent hover:text-foreground",
				"data-active:bg-accent data-active:text-foreground",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
			)}
			nativeButton={false}
			render={<div />}
			value={fileTabId(path)}
		>
			<span className="max-w-40 truncate">{basename}</span>
			<button
				aria-label={`Close ${basename}`}
				className="shrink-0 rounded p-0.5 opacity-0 hover:bg-background/60 group-hover:opacity-100 group-data-active:opacity-100"
				onClick={(event) => {
					event.stopPropagation();
					onClose();
				}}
				onPointerDown={(event) => {
					event.stopPropagation();
				}}
				type="button"
			>
				<XIcon className="size-3" />
			</button>
		</TabsPrimitive.Tab>
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
