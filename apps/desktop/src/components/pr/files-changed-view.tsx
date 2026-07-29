"use client";

import { Columns2Icon, RowsIcon, SlidersHorizontalIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { DiffPane } from "#/components/diff-pane/diff-pane";
import { FilesSidebar } from "#/components/files-sidebar/files-sidebar";
import { buttonVariants } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileChange, ReviewState, Session } from "#/lib/pr-data";
import { useDiffStyleMode, useSidebarViewMode } from "#/lib/settings-data";
import { cn } from "#/lib/utils";

type FilesChangedViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewState>;
	setViewed: (path: string, viewed: boolean) => void;
};

export function FilesChangedView({
	session,
	orpc,
	files,
	reviewState,
	setViewed,
}: FilesChangedViewProps): React.ReactElement {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [viewMode, setViewMode] = useSidebarViewMode(orpc);
	const [diffStyle, setDiffStyle] = useDiffStyleMode(orpc);

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
			</div>
			<div className="flex min-h-0 flex-1">
				<FilesSidebar
					files={files}
					onSelectPath={setSelectedPath}
					reviewState={reviewState}
					selectedPath={selectedPath}
					viewMode={viewMode}
				/>
				<DiffPane
					diffStyle={diffStyle}
					files={files}
					orpc={orpc}
					reviewState={reviewState}
					selectedPath={selectedPath}
					sessionId={session.id}
					setViewed={setViewed}
				/>
			</div>
		</div>
	);
}
