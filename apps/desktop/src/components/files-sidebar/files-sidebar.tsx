"use client";

import { SearchIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { FileTreeView } from "#/components/files-sidebar/file-tree-view";
import { FlatFileGroup } from "#/components/files-sidebar/flat-file-group";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { ScrollArea } from "#/components/ui/scroll-area";
import { useKeyBindings } from "#/hooks/use-key-bindings";
import type { FileChange, ReviewStateEntry } from "#/lib/pr-data";
import type { SidebarViewMode } from "#/lib/settings-data";
import { CATEGORY_LABELS, groupFilesByCategory } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";
import { Button, buttonVariants } from "../ui/button";

/** The files sidebar's search box: filter by file path (today's default) or grep loaded diff content. */
export type SearchMode = "files" | "keyword";

const SEARCH_MODE_PLACEHOLDER: Record<SearchMode, string> = {
	files: "Filter files…",
	keyword: "Search in diffs…",
};

type FilesSidebarProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	viewMode: SidebarViewMode;
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

	useKeyBindings(
		{
			"mod+f": () => {
				onSearchModeChange("files");
				filterInputRef.current?.focus();
				filterInputRef.current?.select();
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
				filterInputRef.current?.focus();
				filterInputRef.current?.select();
			},
		},
		{ enabled: shortcutsEnabled },
	);

	return (
		<div className="flex h-full w-72 shrink-0 flex-col bg-pane-surface pb-2">
			<div className="p-2">
				<InputGroup>
					<InputGroupAddon>
						<SearchIcon className="size-3.5" />
					</InputGroupAddon>
					<InputGroupInput
						aria-label={
							searchMode === "keyword" ? "Search diff content" : "Filter files"
						}
						onChange={(event) => onFilterQueryChange(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape") {
								// `<input type="search">` clears itself natively on Escape
								// (WebKit) — suppressed so this first Escape only blurs and
								// hands the query intact to `j`/`k`. A second Escape, once
								// focus has left the input, clears it via the global
								// `Escape` binding in `FilesChangedView`.
								event.preventDefault();
								event.currentTarget.blur();
								return;
							}
							if (event.key === "Enter") {
								// Blurs unconditionally (same as Escape) so the natural
								// type→Enter→`n`→`n` flow works — `n`/`N` are bare
								// bindings, suppressed while this input has focus.
								event.preventDefault();
								onQuerySubmit();
								event.currentTarget.blur();
							}
						}}
						placeholder={SEARCH_MODE_PLACEHOLDER[searchMode]}
						ref={filterInputRef}
						type="search"
						value={filterQuery}
					/>
					{filterQuery.length > 0 && (
						<InputGroupAddon align="inline-end">
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Clear filter"
								onClick={() => {
									onFilterQueryChange("");
									filterInputRef.current?.focus();
								}}
								type="button"
							>
								<XIcon aria-hidden="true" />
							</Button>
						</InputGroupAddon>
					)}
					<InputGroupAddon align="inline-end">
						<DropdownMenu>
							<DropdownMenuTrigger
								aria-label="Search mode"
								className={cn(
									buttonVariants({ variant: "ghost", size: "icon-xs" }),
								)}
							>
								<SlidersHorizontalIcon aria-hidden="true" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end">
								<DropdownMenuRadioGroup
									onValueChange={(value) =>
										onSearchModeChange(value as SearchMode)
									}
									value={searchMode}
								>
									<DropdownMenuRadioItem closeOnClick value="files">
										Files
									</DropdownMenuRadioItem>
									<DropdownMenuRadioItem closeOnClick value="keyword">
										Keyword
									</DropdownMenuRadioItem>
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					</InputGroupAddon>
				</InputGroup>
			</div>
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
					files={files}
					onMarkReviewed={onMarkReviewed}
					onSelectPath={onSelectPath}
					repoRoot={repoRoot}
					reviewState={reviewState}
					selectedPath={selectedPath}
				/>
			) : (
				<ScrollArea className="min-h-0 flex-1" scrollFade>
					<div className="flex flex-col gap-1 pb-3">
						{groups.map((group) => (
							<FlatFileGroup
								key={group.category}
								files={group.files}
								onSelectPath={onSelectPath}
								reviewState={reviewState}
								selectedPath={selectedPath}
								title={CATEGORY_LABELS[group.category]}
							/>
						))}
					</div>
				</ScrollArea>
			)}
		</div>
	);
}
