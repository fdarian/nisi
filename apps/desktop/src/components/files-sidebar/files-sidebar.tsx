"use client";

import { SearchIcon, XIcon } from "lucide-react";
import { useMemo, useRef } from "react";
import { FileTreeView } from "#/components/files-sidebar/file-tree-view";
import { FlatFileGroup } from "#/components/files-sidebar/flat-file-group";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import { ScrollArea } from "#/components/ui/scroll-area";
import { useKeyBindings } from "#/hooks/use-key-bindings";
import type { FileChange, ReviewStateEntry } from "#/lib/pr-data";
import type { SidebarViewMode } from "#/lib/settings-data";
import { CATEGORY_LABELS, groupFilesByCategory } from "#/lib/tree-paths";
import { Button } from "../ui/button";

type FilesSidebarProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	viewMode: SidebarViewMode;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
	/** Owned by `FilesChangedView` — a keyboard `j`/`k` walk needs the same
	 * filtered list the sidebar renders, not just its own unfiltered `files`. */
	filterQuery: string;
	onFilterQueryChange: (query: string) => void;
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
	filterQuery,
	onFilterQueryChange,
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
						aria-label="Filter files"
						onChange={(event) => onFilterQueryChange(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape") return;
							// `<input type="search">` clears itself natively on Escape
							// (WebKit) — suppressed so this first Escape only blurs and
							// hands the query intact to `j`/`k`. A second Escape, once
							// focus has left the input, clears it via the global
							// `Escape` binding in `FilesChangedView`.
							event.preventDefault();
							event.currentTarget.blur();
						}}
						placeholder="Filter files…"
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
					onSelectPath={onSelectPath}
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
