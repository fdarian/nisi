"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
	Columns2Icon,
	RefreshCwIcon,
	RowsIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { DiffPaneHandle } from "#/components/diff-pane/diff-pane";
import { DiffPane } from "#/components/diff-pane/diff-pane";
import { EditorPickerPalette } from "#/components/editor-picker-palette";
import type { SearchMode } from "#/components/files-sidebar/files-sidebar";
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
import { toastManager } from "#/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import type { EditorInfo } from "#/hooks/use-available-editors";
import {
	openInEditor,
	useAvailableEditors,
} from "#/hooks/use-available-editors";
import { useKeyBindings } from "#/hooks/use-key-bindings";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import {
	type DiffMatch,
	diffContentMatchesQuery,
	findDiffMatches,
} from "#/lib/diff-search";
import type {
	FileChange,
	FileContentsMap,
	ReviewStateEntry,
	Session,
} from "#/lib/pr-data";
import { pullRequestUrl, useFileContents } from "#/lib/pr-data";
import {
	useSessionCurrentMatchIndex,
	useSessionFileHistory,
	useSessionFilterQuery,
	useSessionForcedPaths,
	useSessionSearchMode,
	useSessionSelectedPath,
	useSessionUndoStack,
} from "#/lib/session-ui-store";
import {
	useDiffStyleMode,
	useHideReviewed,
	useIncludeUncommitted,
	usePreferredEditor,
	useSidebarViewMode,
	useWrapLines,
} from "#/lib/settings-data";
import { comparePaths } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

/** Stable identity for the "keyword mode inactive" case — a fresh `[]`/`Map` every render would defeat `DiffPane`'s `items` memo just as surely as a genuinely different value would. */
const EMPTY_MATCHES: readonly DiffMatch[] = [];
const EMPTY_MATCHES_BY_PATH: ReadonlyMap<string, readonly DiffMatch[]> =
	new Map();

type FilesChangedViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
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
	hasPendingChanges,
	onRefresh,
	shortcutsEnabled,
}: FilesChangedViewProps): React.ReactElement {
	// All of `selectedPath` through `forcedPaths`/the undo stack below live in
	// the per-session UI store (`session-ui-store.ts`), not local `useState` —
	// an inactive tab eventually suspends (`app-shell.tsx`'s
	// `useTabSuspension`), which unmounts this component entirely, and resume
	// needs to land back on the same selection/filter/search position rather
	// than resetting it.
	const [selectedPath, setSelectedPath] = useSessionSelectedPath(session.id);
	const diffPaneRef = useRef<DiffPaneHandle>(null);

	// ⌘[/⌘] back/forward history over `selectedPath` — see
	// `session-ui-store.tsx`'s `useSessionFileHistory` doc comment for why
	// this is imperative rather than a `useStore` subscription.
	const fileHistory = useSessionFileHistory(session.id);

	// Every file click scrolls the diff pane, not just the ones that change
	// the selection: re-clicking the already-selected file leaves
	// `selectedPath` identical, so nothing downstream of this state can tell
	// the click happened at all (see `DiffPaneHandle`). `FileTreeGroup` /
	// `FlatFileGroup` already scroll their own row into view on that same
	// click for the same reason.
	//
	// This is also the app's one explicit-selection site — sidebar clicks,
	// `j`/`k` (`selectRelative` below), and undo landing on a file
	// (`handleUndo`) all funnel through here — so it's also where a
	// deliberate jump gets pushed onto the ⌘[/⌘] history stack.
	const selectPath = useCallback(
		(path: string) => {
			setSelectedPath(path);
			fileHistory.push(path);
			diffPaneRef.current?.scrollToPath(path);
		},
		[setSelectedPath, fileHistory],
	);

	// Lifted from `FilesSidebar` — `j`/`k` need to walk the same filtered
	// list the sidebar renders, so the filtering itself (not just the query
	// string) lives here now. `FilesSidebar` still owns grouping.
	const [filterQuery, setFilterQuery] = useSessionFilterQuery(session.id);
	// Ephemeral, not a persisted setting — it's tied to the transient query
	// above, not a standing preference like `viewMode`/`hideReviewed` below.
	const [searchMode, setSearchMode] = useSessionSearchMode(session.id);
	// Which match `n`/`N`/Enter last parked on, as an index into
	// `keywordMatches` below — always read through `currentMatchIndexInBounds`
	// (safe modulo), not directly, since the match list can shrink out from
	// under a raw index (the query changes, or a file's content changes) and
	// there's no effect keeping this in sync. Reset to 0 wherever the query
	// or mode changes (`handleFilterQueryChange`/`handleSearchModeChange`
	// below), so "current" always starts back at the first match.
	const [currentMatchIndex, setCurrentMatchIndex] = useSessionCurrentMatchIndex(
		session.id,
	);
	// `setCurrentMatchIndex` alone isn't enough for `navigateMatch` (below) to
	// stack correctly: React batches state updates, so two `n` keydowns
	// dispatched before a re-render would both compute "current + 1" off the
	// same stale `currentMatchIndex` and land on the same index instead of
	// advancing twice (confirmed live — a burst of rapid-fire keydowns only
	// ever advanced by one). This ref is written synchronously alongside
	// every `setCurrentMatchIndex` call (`setCurrentMatchIndexBoth` below),
	// so `navigateMatch` always computes its next step from the true latest
	// value regardless of React's render timing.
	const currentMatchIndexRef = useRef(currentMatchIndex);
	const setCurrentMatchIndexBoth = useCallback(
		(index: number) => {
			currentMatchIndexRef.current = index;
			setCurrentMatchIndex(index);
		},
		[setCurrentMatchIndex],
	);

	const [viewMode, setViewMode] = useSidebarViewMode(orpc);
	const [diffStyle, setDiffStyle] = useDiffStyleMode(orpc);
	const [hideReviewed, setHideReviewed] = useHideReviewed(orpc);
	const [includeUncommitted, setIncludeUncommitted] =
		useIncludeUncommitted(orpc);
	const [wrapLines, setWrapLines] = useWrapLines(orpc);
	const [preferredEditor, setPreferredEditor] = usePreferredEditor(orpc);
	const { editors, loadEditors } = useAvailableEditors();
	const [editorPickerOpen, setEditorPickerOpen] = useState(false);

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

	// Lifted from `DiffPane` (rather than duplicated) — its keyword-search
	// predicate below and the diff pane's own rendering need to read the
	// exact same `useFileContents` call so TanStack Query dedupes both to one
	// cached entry per chunk instead of mounting two independently-chunked
	// fetches. `contentPaths` deliberately comes from `files` (the unfiltered
	// prop), not `visibleFiles`/`queryFilteredFiles` below, for the same
	// reason `DiffPane` used to key its chunks off `allFiles`: a file
	// dropping out of the filtered/hide-reviewed view must never reshuffle
	// another chunk's boundary.
	const contentPaths = useMemo(
		() => files.filter((file) => !file.binary).map((file) => file.path),
		[files],
	);
	const [forcedPaths, addForcedPath] = useSessionForcedPaths(session.id);
	const fileContents: FileContentsMap = useFileContents(
		orpc,
		session.id,
		contentPaths,
		forcedPaths,
	);

	// What the sidebar actually renders — `visibleFiles` narrowed by the text
	// filter. `j`/`k` walk this list; `DiffPane` below keeps receiving the
	// unfiltered `visibleFiles`, since the text filter only narrows the
	// sidebar today. Files mode filters by path (untouched); keyword mode
	// greps each file's loaded diff content instead — only run once the query
	// is non-empty, so files mode (and an empty query in either mode) never
	// pays for a content pass.
	const queryFilteredFiles = useMemo(() => {
		const query = filterQuery.trim().toLowerCase();
		if (!query) return visibleFiles;
		if (searchMode === "keyword") {
			return visibleFiles.filter((file) =>
				diffContentMatchesQuery(fileContents.get(file.path)?.content, query),
			);
		}
		return visibleFiles.filter((file) =>
			file.path.toLowerCase().includes(query),
		);
	}, [visibleFiles, filterQuery, searchMode, fileContents]);

	// Keyword mode with a non-empty query is a different *view* of the diff
	// pane, not just a sidebar narrowing: the pane itself shows only the
	// matched hunks (`DiffPane`'s ~L409-412 branch), so it needs both the
	// narrowed file list and, per file, where the matches actually are.
	// Files mode never reaches here — `keywordMatchesByPath` stays the shared
	// empty map, and `diffPaneFiles` stays `visibleFiles`, exactly today's
	// behavior.
	const isKeywordFilterActive =
		searchMode === "keyword" && filterQuery.trim() !== "";
	const diffPaneFiles = isKeywordFilterActive
		? queryFilteredFiles
		: visibleFiles;
	// The flat, ordered match list — file order (`queryFilteredFiles`, already
	// sorted to match render order), then line, then offset. `currentMatchIndex`
	// and the "x of y" footer both index into this directly.
	const keywordMatches = useMemo(() => {
		if (!isKeywordFilterActive) return EMPTY_MATCHES;
		const query = filterQuery.trim().toLowerCase();
		return findDiffMatches(queryFilteredFiles, fileContents, query);
	}, [isKeywordFilterActive, filterQuery, queryFilteredFiles, fileContents]);

	const keywordMatchesByPath = useMemo(() => {
		if (keywordMatches.length === 0) return EMPTY_MATCHES_BY_PATH;
		const grouped = new Map<string, DiffMatch[]>();
		for (const match of keywordMatches) {
			const existing = grouped.get(match.path);
			if (existing) existing.push(match);
			else grouped.set(match.path, [match]);
		}
		return grouped;
	}, [keywordMatches]);

	// Safe modulo, not the raw index — `keywordMatches` can shrink (a query
	// edit, or a file's content settling) without anything resetting
	// `currentMatchIndex` in between, so a stale index must still resolve to
	// something in range rather than `undefined`.
	const currentMatchIndexInBounds =
		keywordMatches.length === 0
			? 0
			: ((currentMatchIndex % keywordMatches.length) + keywordMatches.length) %
				keywordMatches.length;
	const currentMatch: DiffMatch | undefined =
		keywordMatches[currentMatchIndexInBounds];

	// Every place the query/mode itself changes resets navigation back to the
	// first match — typing a new query (or switching modes) makes the
	// previous "current" position meaningless.
	const handleFilterQueryChange = useCallback(
		(value: string) => {
			setFilterQuery(value);
			setCurrentMatchIndexBoth(0);
		},
		[setFilterQuery, setCurrentMatchIndexBoth],
	);
	const handleSearchModeChange = useCallback(
		(mode: SearchMode) => {
			setSearchMode(mode);
			setCurrentMatchIndexBoth(0);
		},
		[setSearchMode, setCurrentMatchIndexBoth],
	);

	// Jumps to an absolute match index: records it as "current", crosses
	// `selectedPath` into that match's file when it lives elsewhere (so the
	// sidebar never disagrees with what the pane is showing), and scrolls the
	// pane to it. Shared by `n`/`N` (relative, via `navigateMatch` below) and
	// by the filter input's Enter (`handleQuerySubmit`, always index 0).
	const jumpToMatch = useCallback(
		(index: number) => {
			if (keywordMatches.length === 0) return;
			setCurrentMatchIndexBoth(index);
			const match = keywordMatches[index];
			if (match === undefined) return;
			if (match.path !== selectedPath) setSelectedPath(match.path);
			diffPaneRef.current?.scrollToMatch(match);
		},
		[keywordMatches, selectedPath, setSelectedPath, setCurrentMatchIndexBoth],
	);

	// Reads `currentMatchIndexRef`, not the `currentMatchIndexInBounds` state
	// derived value — see the ref's own doc comment for why a state read
	// isn't safe here under rapid-fire `n`/`N` calls.
	const navigateMatch = useCallback(
		(direction: 1 | -1) => {
			if (keywordMatches.length === 0) return;
			const base =
				((currentMatchIndexRef.current % keywordMatches.length) +
					keywordMatches.length) %
				keywordMatches.length;
			const nextIndex =
				(((base + direction) % keywordMatches.length) + keywordMatches.length) %
				keywordMatches.length;
			jumpToMatch(nextIndex);
		},
		[keywordMatches, jumpToMatch],
	);

	// Enter in the filter input always jumps to the *first* match (index 0),
	// regardless of wherever `n`/`N` last left `currentMatchIndex` — the
	// natural type→Enter→`n`→`n` flow, and re-pressing Enter after navigating
	// away is "start over from the top", not "stay put". A no-op when
	// there's nothing to jump to (files mode, or a keyword query with zero
	// matches); `FilesSidebar` blurs the input regardless, same as it
	// already does for Escape.
	const handleQuerySubmit = useCallback(() => {
		jumpToMatch(0);
	}, [jumpToMatch]);

	// Lives in the per-session store too (see the doc comment above
	// `selectedPath`) — same non-reactive-ref semantics as before (nothing
	// renders off it), just addressable by session id so it survives this
	// component unmounting on suspend.
	const undoStack = useSessionUndoStack(session.id);

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

	// `r`/`R`'s post-toggle selection: advance to the next (`r`, `direction:
	// 1`) or previous (`R`, `direction: -1`) file in `queryFilteredFiles`,
	// falling back to the opposite direction when there isn't one that way —
	// same no-wrap edges as `selectRelative` itself, so a single-file list
	// leaves the selection alone either way. Reads `queryFilteredFiles` from
	// this render's closure, the same pre-toggle snapshot `selectRelative`
	// itself reads.
	const handleToggleReviewed = useCallback(
		(direction: 1 | -1) => {
			if (selectedPath === null) return;
			const previousViewed = isViewed(selectedPath);
			undoStack.push({ path: selectedPath, previousViewed });
			setViewed(selectedPath, !previousViewed);
			const currentIndex = queryFilteredFiles.findIndex(
				(file) => file.path === selectedPath,
			);
			const hasFileInDirection =
				currentIndex !== -1 &&
				currentIndex + direction >= 0 &&
				currentIndex + direction < queryFilteredFiles.length;
			selectRelative(hasFileInDirection ? direction : (-direction as 1 | -1));
		},
		[
			selectedPath,
			isViewed,
			setViewed,
			selectRelative,
			undoStack,
			queryFilteredFiles,
		],
	);

	const handleUndo = useCallback(() => {
		const lastRecord = undoStack.pop();
		if (!lastRecord) return;
		setViewed(lastRecord.path, lastRecord.previousViewed);
		selectPath(lastRecord.path);
	}, [undoStack, setViewed, selectPath]);

	// Tree view's right-click "Mark as Reviewed"/"Mark Folder as Reviewed" —
	// no undo stack entry, unlike `handleToggleReviewed`: a folder can resolve
	// to many paths, and this is a one-way "mark reviewed" action rather than
	// `r`'s toggle, so there's no single prior state to restore.
	const handleMarkReviewed = useCallback(
		(paths: readonly string[]) => {
			for (const path of paths) setViewed(path, true);
		},
		[setViewed],
	);

	// What "stale" means for ⌘[/⌘]: `files` is the current PR's full,
	// unfiltered file list — a history entry whose path has dropped out of
	// it was removed by a PR update, not merely hidden by "Hide reviewed" or
	// the search box, so back/forward should still land on a filtered-out
	// file but skip one a PR update actually dropped.
	const filePathSet = useMemo(
		() => new Set(files.map((file) => file.path)),
		[files],
	);
	const isValidHistoryPath = useCallback(
		(path: string) => filePathSet.has(path),
		[filePathSet],
	);

	// Mirror `selectPath`'s set-and-scroll, but move the history cursor
	// instead of pushing to it — back/forward must never push or truncate
	// (see `useSessionFileHistory`). Silently a no-op when nothing valid
	// remains in that direction.
	const handleHistoryBack = useCallback(() => {
		const path = fileHistory.back(isValidHistoryPath);
		if (path === undefined) return;
		setSelectedPath(path);
		diffPaneRef.current?.scrollToPath(path);
	}, [fileHistory, isValidHistoryPath, setSelectedPath]);

	const handleHistoryForward = useCallback(() => {
		const path = fileHistory.forward(isValidHistoryPath);
		if (path === undefined) return;
		setSelectedPath(path);
		diffPaneRef.current?.scrollToPath(path);
	}, [fileHistory, isValidHistoryPath, setSelectedPath]);

	// The diff pane's scroll-driven focus report (`DiffPane`'s
	// `onVisiblePathChange`) — replaces the entry at the history cursor in
	// place rather than pushing (scroll drift is never a deliberate jump),
	// and stays wired to the *raw* `setSelectedPath` rather than `selectPath`
	// for the same anti-feedback-loop reason `DiffPane`'s own prop doc
	// comment gives: calling `scrollToPath` here would fight the scroll that
	// produced this report.
	const handleVisiblePathChange = useCallback(
		(path: string) => {
			setSelectedPath(path);
			fileHistory.replaceAtCursor(path);
		},
		[setSelectedPath, fileHistory],
	);

	// "o e" leader shortcut — opens the selected file in `preferredEditor`
	// (Settings ⌘,), same as `DiffFileHeader`'s "Open in..." menu entry but
	// against the standing preference instead of a picked-per-click editor.
	// The first time, before any preference exists, it opens
	// `EditorPickerPalette` to choose one instead of silently guessing —
	// `handlePickEditor` below persists that pick, so every "o e" after this
	// one goes straight to `preferredEditor`. A no-op when nothing's
	// selected; a toast when there's nothing installed to even pick from.
	//
	// `editors` is only probed lazily, right in the branch that needs it —
	// this shortcut may never be pressed for a given tab, so there's no
	// reason to fire a Tauri `invoke` for every open `FilesChangedView` up
	// front just to support it. The already-set-`preferredEditor` branch
	// below deliberately skips that probe (and so may show the raw scheme
	// instead of the editor's display name if this tab never loaded the list
	// some other way) rather than pay a round trip on every press of an
	// already-working shortcut.
	const handleOpenInPreferredEditor = useCallback(async () => {
		if (selectedPath === null) return;

		if (preferredEditor !== null) {
			const editorName =
				editors.find((editor) => editor.id === preferredEditor)?.name ??
				preferredEditor;
			openInEditor(
				preferredEditor,
				editorName,
				session.repoRoot,
				`${session.repoRoot}/${selectedPath}`,
			);
			return;
		}

		const availableEditors = await loadEditors();
		if (availableEditors.length === 0) {
			toastManager.add({
				title: "No editors found",
				description:
					"Install VS Code, Cursor, Zed, or Windsurf to use this shortcut.",
				type: "info",
			});
			return;
		}
		setEditorPickerOpen(true);
	}, [selectedPath, preferredEditor, editors, loadEditors, session.repoRoot]);

	const handlePickEditor = useCallback(
		(editor: EditorInfo) => {
			setEditorPickerOpen(false);
			setPreferredEditor(editor.id);
			if (selectedPath === null) return;
			openInEditor(
				editor.id,
				editor.name,
				session.repoRoot,
				`${session.repoRoot}/${selectedPath}`,
			);
		},
		[selectedPath, setPreferredEditor, session.repoRoot],
	);

	// "o g" leader shortcut — same URL, same behavior as the ⌘K palette's
	// "Open Pull Request in GitHub" action (`command-palette.tsx`); a no-op
	// for a branch-only session, which has no PR to open.
	const handleOpenPrInGitHub = useCallback(() => {
		if (session.target.kind !== "pr") return;
		void openUrl(pullRequestUrl(session.target));
	}, [session.target]);

	useKeyBindings(
		{
			j: () => selectRelative(1),
			k: () => selectRelative(-1),
			r: () => handleToggleReviewed(1),
			// Mirrors `r` exactly — same toggle, same undo-stack push — but walks
			// `queryFilteredFiles` backward instead of forward.
			R: () => handleToggleReviewed(-1),
			u: handleUndo,
			"mod+[": handleHistoryBack,
			"mod+]": handleHistoryForward,
			"o e": handleOpenInPreferredEditor,
			"o g": handleOpenPrInGitHub,
			// Suppressed while the filter input has focus (bare-key guard in
			// `useKeyBindings`), so typing "n" into a query never fires this —
			// only meaningful once the input's been blurred (Enter, or a click
			// elsewhere). Both wrap; a no-op with zero matches.
			n: () => navigateMatch(1),
			N: () => navigateMatch(-1),
			// The filter input's own `onKeyDown` (`FilesSidebar`) already
			// preventDefaults and blurs on the *first* Escape while it's
			// focused — the bare-key guard in `useKeyBindings` suppresses
			// this binding for that same keypress (its target is still the
			// input). This only ever fires on a second Escape, once focus
			// has left the input; a no-op when the query's already empty
			// keeps it from interfering with something else's Escape
			// handler (e.g. a Base UI popover) once there's nothing to clear.
			Escape: () => {
				if (filterQuery !== "") handleFilterQueryChange("");
			},
		},
		{ enabled: shortcutsEnabled },
	);

	return (
		<>
			<div className="flex min-h-0 flex-1">
				<FilesSidebar
					shortcutsEnabled={shortcutsEnabled}
					filterQuery={filterQuery}
					files={queryFilteredFiles}
					onFilterQueryChange={handleFilterQueryChange}
					onMarkReviewed={handleMarkReviewed}
					onQuerySubmit={handleQuerySubmit}
					onSearchModeChange={handleSearchModeChange}
					onSelectPath={selectPath}
					repoRoot={session.repoRoot}
					reviewState={reviewState}
					searchMode={searchMode}
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
								<Button
									onClick={onRefresh}
									size="xs"
									variant="warning-secondary"
								>
									<RefreshCwIcon />
									Refresh
								</Button>
							)}
							<ToggleGroup
								onValueChange={(value) => {
									const next = value[0];
									if (next === "unified" || next === "split")
										setDiffStyle(next);
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
										checked={wrapLines}
										onCheckedChange={setWrapLines}
									>
										Wrap lines
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
						currentMatch={currentMatch}
						diffStyle={diffStyle}
						fileContents={fileContents}
						files={diffPaneFiles}
						forcedPaths={forcedPaths}
						keywordMatchesByPath={keywordMatchesByPath}
						onForceLoad={addForcedPath}
						onVisiblePathChange={handleVisiblePathChange}
						orpc={orpc}
						ref={diffPaneRef}
						repoRoot={session.repoRoot}
						reviewState={reviewState}
						selectedPath={selectedPath}
						sessionId={session.id}
						setViewed={setViewed}
						wrapLines={wrapLines}
					/>
					{isKeywordFilterActive && (
						<div className="mx-3 flex shrink-0 items-center justify-center rounded-xl bg-background px-3 py-1.5 text-muted-foreground text-xs">
							{keywordMatches.length === 0 ? (
								<span>No matches</span>
							) : (
								<span>
									<span className="font-medium text-foreground tabular-nums">
										{currentMatchIndexInBounds + 1}
									</span>{" "}
									of{" "}
									<span className="font-medium text-foreground tabular-nums">
										{keywordMatches.length}
									</span>{" "}
									matches
								</span>
							)}
						</div>
					)}
				</div>
			</div>
			<EditorPickerPalette
				editors={editors}
				onOpenChange={setEditorPickerOpen}
				onSelect={handlePickEditor}
				open={editorPickerOpen}
			/>
		</>
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
