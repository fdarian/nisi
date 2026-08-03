"use client";

import {
	Columns2Icon,
	RefreshCwIcon,
	RowsIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffPaneHandle } from "#/components/diff-pane/diff-pane";
import { DiffPane } from "#/components/diff-pane/diff-pane";
import { FilesSidebar } from "#/components/files-sidebar/files-sidebar";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import { useKeyBindings } from "#/hooks/use-key-bindings";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileChange, ReviewStateEntry, Session } from "#/lib/pr-data";
import {
	useDiffStyleMode,
	useHideReviewed,
	useIncludeUncommitted,
	useSidebarViewMode,
} from "#/lib/settings-data";
import { comparePaths } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

/** One `r` keypress's undo record — concrete to this one toggle, not a generic action union. */
type ReviewedToggleRecord = {
	path: string;
	previousViewed: boolean;
};

type FilesChangedViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
	onNavigateToBlock: (blockId: string) => void;
	hasPendingChanges: boolean;
	onRefresh: () => void;
	/** Whether this PR tab is the selected one — `PrView` stays mounted for every
	 * open tab, so `j`/`k`/`r`/`u` here (and `mod+f` in `FilesSidebar`) must stay
	 * off while a background tab's `FilesChangedView` isn't what's on screen. */
	shortcutsEnabled: boolean;
};

export function FilesChangedView({
	session,
	orpc,
	files,
	reviewState,
	setViewed,
	onNavigateToBlock,
	hasPendingChanges,
	onRefresh,
	shortcutsEnabled,
}: FilesChangedViewProps): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const diffPaneRef = useRef<DiffPaneHandle>(null);

	// Every file click scrolls the diff pane, not just the ones that change
	// the selection: re-clicking the already-selected file leaves
	// `selectedPath` identical, so nothing downstream of this state can tell
	// the click happened at all (see `DiffPaneHandle`). `FileTreeGroup` /
	// `FlatFileGroup` already scroll their own row into view on that same
	// click for the same reason.
	const selectPath = useCallback((path: string) => {
		setSelectedPath(path);
		diffPaneRef.current?.scrollToPath(path);
	}, []);

	// Lifted from `FilesSidebar` — `j`/`k` need to walk the same filtered
	// list the sidebar renders, so the filtering itself (not just the query
	// string) lives here now. `FilesSidebar` still owns grouping.
	const [filterQuery, setFilterQuery] = useState("");

	const [viewMode, setViewMode] = useSidebarViewMode(orpc);
	const [diffStyle, setDiffStyle] = useDiffStyleMode(orpc);
	const [hideReviewed, setHideReviewed] = useHideReviewed(orpc);
	const [includeUncommitted, setIncludeUncommitted] =
		useIncludeUncommitted(orpc);

	const viewedCount = useMemo(
		() =>
			files.filter((file) => reviewState.get(file.path)?.status === "viewed")
				.length,
		[files, reviewState],
	);

	// Filters out already-reviewed files for both the sidebar and the diff
	// pane's list when "Hide reviewed" is on — the header counter below stays
	// keyed off the unfiltered `files`/`viewedCount` so "N of M" keeps
	// reporting real progress instead of collapsing toward "0 of M" as
	// reviewed files disappear from view.
	//
	// Sorted with the same `comparePaths` the tree sidebar uses, so the diff
	// pane's card order (which never re-sorts) walks the tree in the same
	// order the sidebar renders it, instead of the backend's flat
	// whole-path `localeCompare` order.
	const visibleFiles = useMemo(() => {
		const filtered = hideReviewed
			? files.filter((file) => reviewState.get(file.path)?.status !== "viewed")
			: files;
		return [...filtered].sort((a, b) => comparePaths(a.path, b.path));
	}, [files, reviewState, hideReviewed]);

	// What the sidebar actually renders — `visibleFiles` narrowed by the text
	// filter. `j`/`k` walk this list; `DiffPane` below keeps receiving the
	// unfiltered `visibleFiles`, since the text filter only narrows the
	// sidebar today.
	const queryFilteredFiles = useMemo(() => {
		const query = filterQuery.trim().toLowerCase();
		if (!query) return visibleFiles;
		return visibleFiles.filter((file) =>
			file.path.toLowerCase().includes(query),
		);
	}, [visibleFiles, filterQuery]);

	// A ref, not state: nothing renders off the undo stack, and a setState
	// updater is the wrong place for `setViewed`/`selectPath`'s side effects —
	// StrictMode double-invokes updaters in dev, which would fire the
	// mutation twice.
	const undoStackRef = useRef<ReviewedToggleRecord[]>([]);

	// Mirrors exactly how `DiffPane` derives the `viewed` boolean it passes to
	// `handleToggleViewed` — the one other place a file's reviewed flag gets
	// toggled — so `r` can't drift from a different notion of "current value".
	const isViewed = useCallback(
		(path: string) => reviewState.get(path)?.status === "viewed",
		[reviewState],
	);

	// Shared by `j`/`k` and by `r`'s post-toggle advance: `direction` walks
	// `queryFilteredFiles` from `selectedPath`, with no wrap at either end.
	// Nothing selected yet resolves to the first file walking forward, the
	// last file walking backward.
	const selectRelative = useCallback(
		(direction: 1 | -1) => {
			if (queryFilteredFiles.length === 0) return;
			const currentIndex =
				selectedPath === null
					? -1
					: queryFilteredFiles.findIndex((file) => file.path === selectedPath);

			if (currentIndex === -1) {
				const edgeFile =
					direction === 1
						? queryFilteredFiles[0]
						: queryFilteredFiles[queryFilteredFiles.length - 1];
				if (edgeFile) selectPath(edgeFile.path);
				return;
			}

			const nextIndex = currentIndex + direction;
			const nextFile = queryFilteredFiles[nextIndex];
			if (nextFile) selectPath(nextFile.path);
		},
		[queryFilteredFiles, selectedPath, selectPath],
	);

	const handleToggleReviewed = useCallback(() => {
		if (selectedPath === null) return;
		const previousViewed = isViewed(selectedPath);
		undoStackRef.current.push({ path: selectedPath, previousViewed });
		setViewed(selectedPath, !previousViewed);
		selectRelative(1);
	}, [selectedPath, isViewed, setViewed, selectRelative]);

	const handleUndo = useCallback(() => {
		const lastRecord = undoStackRef.current.pop();
		if (!lastRecord) return;
		setViewed(lastRecord.path, lastRecord.previousViewed);
		selectPath(lastRecord.path);
	}, [setViewed, selectPath]);

	useKeyBindings(
		{
			j: () => selectRelative(1),
			k: () => selectRelative(-1),
			r: handleToggleReviewed,
			u: handleUndo,
			// The filter input's own `onKeyDown` (`FilesSidebar`) already
			// preventDefaults and blurs on the *first* Escape while it's
			// focused — the bare-key guard in `useKeyBindings` suppresses
			// this binding for that same keypress (its target is still the
			// input). This only ever fires on a second Escape, once focus
			// has left the input; a no-op when the query's already empty
			// keeps it from interfering with something else's Escape
			// handler (e.g. a Base UI popover) once there's nothing to clear.
			Escape: () => {
				if (filterQuery !== "") setFilterQuery("");
			},
		},
		{ enabled: shortcutsEnabled },
	);

	return (
		<div className="flex min-h-0 flex-1">
			<FilesSidebar
				shortcutsEnabled={shortcutsEnabled}
				filterQuery={filterQuery}
				files={queryFilteredFiles}
				onFilterQueryChange={setFilterQuery}
				onSelectPath={selectPath}
				reviewState={reviewState}
				selectedPath={selectedPath}
				viewMode={viewMode}
			/>

			<div className="flex min-h-0 flex-1 flex-col pt-2 gap-2">
				<div className="rounded-xl bg-background px-3 py-2 flex shrink-0 items-center justify-between mx-3 text-muted-foreground text-xs">
					<span className="flex items-center gap-2">
						<ProgressCircle total={files.length} value={viewedCount} />
						<span>
							<span className="font-medium text-foreground tabular-nums">
								{viewedCount}
							</span>{" "}
							of{" "}
							<span className="font-medium text-foreground tabular-nums">
								{files.length}
							</span>{" "}
							viewed
						</span>
					</span>

					<div className="flex items-center gap-2">
						{hasPendingChanges && (
							<Button onClick={onRefresh} size="xs" variant="warning-secondary">
								<RefreshCwIcon />
								Refresh
							</Button>
						)}
						<ToggleGroup
							onValueChange={(value) => {
								const next = value[0];
								if (next === "unified" || next === "split") setDiffStyle(next);
							}}
							size="sm"
							value={[diffStyle]}
							variant="outline"
						>
							<ToggleGroupItem aria-label="Unified diff" value="unified">
								<RowsIcon />
							</ToggleGroupItem>
							<ToggleGroupItem aria-label="Split diff" value="split">
								<Columns2Icon />
							</ToggleGroupItem>
						</ToggleGroup>
						<DropdownMenu>
							<DropdownMenuTrigger
								aria-label="Files sidebar display options"
								className={cn(
									buttonVariants({ variant: "ghost", size: "icon-sm" }),
								)}
							>
								<SlidersHorizontalIcon />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuRadioGroup
									onValueChange={(value) =>
										setViewMode(value as "tree" | "flat")
									}
									value={viewMode}
								>
									<DropdownMenuRadioItem closeOnClick value="tree">
										Tree
									</DropdownMenuRadioItem>
									<DropdownMenuRadioItem closeOnClick value="flat">
										Flat
									</DropdownMenuRadioItem>
								</DropdownMenuRadioGroup>
								<DropdownMenuSeparator />
								<DropdownMenuCheckboxItem
									checked={hideReviewed}
									onCheckedChange={setHideReviewed}
								>
									Hide reviewed
								</DropdownMenuCheckboxItem>
								<DropdownMenuCheckboxItem
									checked={includeUncommitted}
									onCheckedChange={setIncludeUncommitted}
								>
									Include uncommitted
								</DropdownMenuCheckboxItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				</div>
				<DiffPane
					allFiles={files}
					diffStyle={diffStyle}
					files={visibleFiles}
					onNavigateToBlock={onNavigateToBlock}
					orpc={orpc}
					ref={diffPaneRef}
					reviewState={reviewState}
					selectedPath={selectedPath}
					sessionId={session.id}
					setViewed={setViewed}
				/>
			</div>
		</div>
	);
}

// Adapted from magicui's Animated Circular Progress Bar
// (https://magicui.design/docs/components/animated-circular-progress-bar),
// scaled down to an inline badge with no center label — the "N of M viewed"
// text next to it already says the number.
function ProgressCircle({
	value,
	total,
}: {
	value: number;
	total: number;
}): React.ReactElement {
	const circumference = 2 * Math.PI * 45;
	const percentPx = circumference / 100;
	const currentPercent = total === 0 ? 0 : Math.round((value / total) * 100);

	return (
		<svg
			aria-label={`${value} of ${total} viewed`}
			className="size-3.5 shrink-0"
			fill="none"
			role="img"
			strokeWidth="2"
			style={
				{
					"--circumference": circumference,
					"--percent-to-px": `${percentPx}px`,
				} as React.CSSProperties
			}
			viewBox="0 0 100 100"
		>
			<circle
				cx="50"
				cy="50"
				fill="none"
				r="45"
				strokeWidth="10"
				className="stroke-border"
			/>
			<circle
				className="stroke-foreground transition-[stroke-dasharray] duration-300 ease-linear"
				cx="50"
				cy="50"
				fill="none"
				r="45"
				strokeDasharray="calc(var(--percent-current) * var(--percent-to-px)) var(--circumference)"
				strokeLinecap="round"
				strokeWidth="10"
				style={
					{
						"--percent-current": currentPercent,
						transform: "rotate(-90deg)",
						transformOrigin: "50px 50px",
					} as React.CSSProperties
				}
			/>
		</svg>
	);
}
