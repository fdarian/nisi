"use client";

import { Columns2Icon, RowsIcon, SlidersHorizontalIcon } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffPaneHandle } from "#/components/diff-pane/diff-pane";
import { DiffPane } from "#/components/diff-pane/diff-pane";
import { FilesSidebar } from "#/components/files-sidebar/files-sidebar";
import { buttonVariants } from "#/components/ui/button";
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
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileChange, ReviewState, Session } from "#/lib/pr-data";
import {
	useDiffStyleMode,
	useHideReviewed,
	useIncludeUncommitted,
	useSidebarViewMode,
} from "#/lib/settings-data";
import { comparePaths } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

type FilesChangedViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewState>;
	setViewed: (path: string, viewed: boolean) => void;
	onNavigateToBlock: (blockId: string) => void;
};

export function FilesChangedView({
	session,
	orpc,
	files,
	reviewState,
	setViewed,
	onNavigateToBlock,
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
	const [viewMode, setViewMode] = useSidebarViewMode(orpc);
	const [diffStyle, setDiffStyle] = useDiffStyleMode(orpc);
	const [hideReviewed, setHideReviewed] = useHideReviewed(orpc);
	const [includeUncommitted, setIncludeUncommitted] =
		useIncludeUncommitted(orpc);

	const viewedCount = useMemo(
		() =>
			files.filter((file) => reviewState.get(file.path) === "viewed").length,
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
			? files.filter((file) => reviewState.get(file.path) !== "viewed")
			: files;
		return [...filtered].sort((a, b) => comparePaths(a.path, b.path));
	}, [files, reviewState, hideReviewed]);

	return (
		<div className="flex min-h-0 flex-1">
			<FilesSidebar
				files={visibleFiles}
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
