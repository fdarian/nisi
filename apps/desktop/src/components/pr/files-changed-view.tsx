"use client";

import { SlidersHorizontalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { FilesSidebar } from "#/components/files-sidebar/files-sidebar";
import { DiffPanePlaceholder } from "#/components/pr/diff-pane-placeholder";
import { buttonVariants } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { useSidebarViewMode } from "#/hooks/use-sidebar-view-mode";
import type { FileChange, ReviewState } from "#/lib/pr-data";
import { cn } from "#/lib/utils";

type FilesChangedViewProps = {
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewState>;
};

export function FilesChangedView({
	files,
	reviewState,
}: FilesChangedViewProps): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [viewMode, setViewMode] = useSidebarViewMode();

	const viewedCount = useMemo(
		() =>
			files.filter((file) => reviewState.get(file.path) === "viewed").length,
		[files, reviewState],
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex h-9 shrink-0 items-center justify-between border-b px-3 text-muted-foreground text-xs">
				<span>
					Files{" "}
					<span className="font-medium text-foreground tabular-nums">
						{viewedCount}
					</span>{" "}
					of{" "}
					<span className="font-medium text-foreground tabular-nums">
						{files.length}
					</span>{" "}
					files
				</span>
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
							onValueChange={(value) => setViewMode(value as "tree" | "flat")}
							value={viewMode}
						>
							<DropdownMenuRadioItem closeOnClick value="tree">
								Tree
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem closeOnClick value="flat">
								Flat
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<div className="flex min-h-0 flex-1">
				<FilesSidebar
					files={files}
					onSelectPath={setSelectedPath}
					reviewState={reviewState}
					selectedPath={selectedPath}
					viewMode={viewMode}
				/>
				<DiffPanePlaceholder selectedPath={selectedPath} />
			</div>
		</div>
	);
}
