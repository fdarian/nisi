"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FluidHoverHighlight, useFluidHover } from "#/components/fluid-hover";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { ScrollArea } from "#/components/ui/scroll-area";
import type {
	FileChange,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import type { SidebarViewMode } from "#/features/settings/settings-data";
import { useNativeGlassShowing } from "#/features/settings/window-glass";
import { CATEGORY_LABELS, groupFilesByCategory } from "#/lib/tree-paths";
import { useKeyBindings } from "#/lib/use-key-bindings";
import { filesSidebarClassName } from "../files-changed-layout";
import { FileTreeView, type FileTreeViewHandle } from "./file-tree-view";
import { FilesFilter } from "./files-filter";
import { FilesSidebarHeader } from "./files-sidebar-header";
import { FilesSidebarRail } from "./files-sidebar-rail";
import { FlatFileGroup } from "./flat-file-group";

/** The files sidebar's search box: filter by file path (today's default) or grep loaded diff content. */
export type SearchMode = "files" | "keyword";

type FilesSidebarProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	viewMode: SidebarViewMode;
	onViewModeChange: (viewMode: SidebarViewMode) => void;
	hideReviewed: boolean;
	onHideReviewedChange: (hideReviewed: boolean) => void;
	/** Persisted: the sidebar shrinks to a narrow rail rather than unmounting, so the layout beside it stays put. */
	collapsed: boolean;
	onCollapsedChange: (collapsed: boolean) => void;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
	/** Tree view's right-click "Mark as Reviewed"/"Mark Folder as Reviewed" — a
	 * folder target resolves to every file path nested under it. */
	onMarkReviewed: (paths: readonly string[]) => void;
	/** Joined with a tree-row path for "Copy absolute path". */
	repoRoot: string;
	/** Owned by `FilesChangedView` — a keyboard `j`/`k` walk needs the same
	 * filtered list the sidebar renders, not just its own unfiltered `files`. */
	filterQuery: string;
	onFilterQueryChange: (query: string) => void;
	/** Enter in the filter input — keyword mode's "jump to the first match and blur" (`FilesChangedView` owns what "jump" means). Fires regardless of search mode; a no-op in files mode. */
	onQuerySubmit: () => void;
	/** Whether the query filters by file path or greps loaded diff content —
	 * owned by `FilesChangedView` alongside `filterQuery` since it's tied to
	 * the same transient query, not a persisted setting. */
	searchMode: SearchMode;
	onSearchModeChange: (mode: SearchMode) => void;
	/** Threaded down from `PrView`'s `isSelectedTab` — `mod+f` must stay off
	 * while this PR tab isn't the one selected, same as `FilesChangedView`'s
	 * own bindings. */
	shortcutsEnabled: boolean;
};

export function FilesSidebar({
	files,
	reviewState,
	viewMode,
	onViewModeChange,
	hideReviewed,
	onHideReviewedChange,
	collapsed,
	onCollapsedChange,
	selectedPath,
	onSelectPath,
	onMarkReviewed,
	repoRoot,
	filterQuery,
	onFilterQueryChange,
	onQuerySubmit,
	searchMode,
	onSearchModeChange,
	shortcutsEnabled,
}: FilesSidebarProps): React.ReactElement {
	// `files` arrives already query-filtered by `FilesChangedView` — this
	// only groups it for the flat view. Grouping stays here (not lifted)
	// since only this component's flat-mode rendering needs it.
	const groups = useMemo(() => groupFilesByCategory(files), [files]);

	const filterInputRef = useRef<HTMLInputElement>(null);
	const treeRef = useRef<FileTreeViewHandle>(null);
	// Initialized from the query so one surviving a tab switch stays visible.
	const [filterOpen, setFilterOpen] = useState(filterQuery !== "");
	// Opening mounts the input, so the focus has to wait for the render after.
	const [focusRequested, setFocusRequested] = useState(false);

	useEffect(() => {
		if (!focusRequested || !filterOpen || collapsed) return;
		const input = filterInputRef.current;
		if (input === null) return;
		setFocusRequested(false);
		input.focus();
		input.select();
	}, [focusRequested, filterOpen, collapsed]);

	const openFilter = () => {
		setFilterOpen(true);
		onCollapsedChange(false);
		setFocusRequested(true);
	};
	const closeFilter = () => {
		setFilterOpen(false);
		onFilterQueryChange("");
	};

	useKeyBindings(
		{
			"mod+b": () => onCollapsedChange(!collapsed),
			"mod+f": () => {
				onSearchModeChange("files");
				openFilter();
			},
			// Not `mod+`-prefixed, so `useKeyBindings` only fires this while no
			// input/textarea/select/contenteditable has focus (`isTextEntry`) —
			// the same guard that already keeps `j`/`k` from stealing a
			// keystroke out of this very input. `preventDefault()` here (unlike
			// `mod+f`, which the hook already prevents by prefix) stops the `/`
			// from landing in the input this same keystroke is about to focus.
			"/": (event) => {
				event.preventDefault();
				onSearchModeChange("keyword");
				openFilter();
			},
		},
		{ enabled: shortcutsEnabled },
	);

	if (collapsed) {
		return (
			<FilesSidebarRail
				onExpand={() => onCollapsedChange(false)}
				onSearch={openFilter}
			/>
		);
	}

	// Handlers sit on the wrapper, not the input, so focus moving to the mode
	// dropdown inside it doesn't count as leaving. Events from that dropdown's
	// portal bubble through React too, hence the `target` checks.
	const handleFilterKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Escape" && event.target === filterInputRef.current)
			closeFilter();
	};
	const handleFilterBlur = (event: React.FocusEvent) => {
		const stayedInside =
			event.relatedTarget instanceof Node &&
			event.currentTarget.contains(event.relatedTarget);
		if (
			event.target === filterInputRef.current &&
			!stayedInside &&
			filterQuery === ""
		)
			setFilterOpen(false);
	};

	return (
		<div className={filesSidebarClassName}>
			<FilesSidebarHeader
				fileCount={files.length}
				hideReviewed={hideReviewed}
				onCollapseAllFolders={() => treeRef.current?.collapseAll()}
				onCollapseSidebar={() => onCollapsedChange(true)}
				onExpandAllFolders={() => treeRef.current?.expandAll()}
				onHideReviewedChange={onHideReviewedChange}
				onSearch={openFilter}
				onViewModeChange={onViewModeChange}
				viewMode={viewMode}
			/>
			{filterOpen && (
				// biome-ignore lint/a11y/noStaticElementInteractions: propagation boundary only; the input inside owns the interaction.
				<div
					className="shrink-0"
					onBlur={handleFilterBlur}
					onKeyDown={handleFilterKeyDown}
				>
					<FilesFilter
						query={filterQuery}
						mode={searchMode}
						inputRef={filterInputRef}
						onQueryChange={onFilterQueryChange}
						onModeChange={onSearchModeChange}
						onSubmit={onQuerySubmit}
					/>
				</div>
			)}
			<div data-files-data className="flex min-h-0 flex-1 flex-col">
				{groups.length === 0 ? (
					<Empty className="px-4 py-8">
						<EmptyTitle className="text-sm">No matching files</EmptyTitle>
						<EmptyDescription>Try a different filter query.</EmptyDescription>
					</Empty>
				) : viewMode === "tree" ? (
					// The tree scrolls itself — that internal scroller *is* the sidebar's
					// one scroll region, and wrapping it in another one would take its
					// height away and stop it windowing rows. Flat mode has no scroller
					// of its own, so it keeps the `ScrollArea`.
					<FileTreeView
						ref={treeRef}
						files={files}
						onMarkReviewed={onMarkReviewed}
						onSelectPath={onSelectPath}
						repoRoot={repoRoot}
						reviewState={reviewState}
						selectedPath={selectedPath}
					/>
				) : (
					<ScrollArea className="min-h-0 flex-1" scrollFade>
						<FlatFileList
							groups={groups}
							onSelectPath={onSelectPath}
							reviewState={reviewState}
							selectedPath={selectedPath}
						/>
					</ScrollArea>
				)}
			</div>
		</div>
	);
}

/** Owns the fluid hover so its listeners attach when the list mounts, not when the sidebar does (it starts in tree mode, with no list). */
function FlatFileList({
	groups,
	reviewState,
	selectedPath,
	onSelectPath,
}: {
	groups: ReturnType<typeof groupFilesByCategory>;
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
}): React.ReactElement {
	const glassShowing = useNativeGlassShowing();
	const hover = useFluidHover<HTMLDivElement>("y");

	return (
		<div
			className="relative flex flex-col gap-1 pb-3"
			ref={hover.containerRef}
			{...(glassShowing ? hover.handlers : {})}
		>
			{glassShowing && (
				<FluidHoverHighlight
					className="rounded-md bg-sidebar-accent"
					hover={hover}
				/>
			)}
			{groups.map((group) => (
				<FlatFileGroup
					key={group.category}
					files={group.files}
					onSelectPath={onSelectPath}
					registerHoverItem={hover.registerItem}
					glassShowing={glassShowing}
					reviewState={reviewState}
					selectedPath={selectedPath}
					title={CATEGORY_LABELS[group.category]}
				/>
			))}
		</div>
	);
}
