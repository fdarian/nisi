"use client";

import { SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { FileTreeGroup } from "#/components/files-sidebar/file-tree-group";
import { FlatFileGroup } from "#/components/files-sidebar/flat-file-group";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
} from "#/components/ui/input-group";
import { ScrollArea } from "#/components/ui/scroll-area";
import type { FileChange, ReviewState } from "#/lib/pr-data";
import type { SidebarViewMode } from "#/lib/settings-data";
import { CATEGORY_LABELS, groupFilesByCategory } from "#/lib/tree-paths";

type FilesSidebarProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewState>;
	viewMode: SidebarViewMode;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
};

export function FilesSidebar({
	files,
	reviewState,
	viewMode,
	selectedPath,
	onSelectPath,
}: FilesSidebarProps): React.ReactElement {
	const [filterQuery, setFilterQuery] = useState("");

	const filteredFiles = useMemo(() => {
		const query = filterQuery.trim().toLowerCase();
		if (!query) return files;
		return files.filter((file) => file.path.toLowerCase().includes(query));
	}, [files, filterQuery]);

	const groups = useMemo(
		() => groupFilesByCategory(filteredFiles),
		[filteredFiles],
	);

	const GroupComponent = viewMode === "tree" ? FileTreeGroup : FlatFileGroup;

	return (
		<div className="flex h-full w-72 shrink-0 flex-col border-sidebar-border border-r bg-sidebar">
			<div className="p-2">
				<InputGroup>
					<InputGroupAddon>
						<SearchIcon className="size-3.5" />
					</InputGroupAddon>
					<InputGroupInput
						aria-label="Filter files"
						onChange={(event) => setFilterQuery(event.currentTarget.value)}
						placeholder="Filter files…"
						type="search"
						value={filterQuery}
					/>
				</InputGroup>
			</div>
			<ScrollArea className="min-h-0 flex-1">
				<div className="flex flex-col gap-1 pb-3">
					{groups.length === 0 ? (
						<Empty className="px-4 py-8">
							<EmptyTitle className="text-sm">No matching files</EmptyTitle>
							<EmptyDescription>Try a different filter query.</EmptyDescription>
						</Empty>
					) : (
						groups.map((group) => (
							<GroupComponent
								key={group.category}
								files={group.files}
								onSelectPath={onSelectPath}
								reviewState={reviewState}
								selectedPath={selectedPath}
								title={CATEGORY_LABELS[group.category]}
							/>
						))
					)}
				</div>
			</ScrollArea>
		</div>
	);
}
