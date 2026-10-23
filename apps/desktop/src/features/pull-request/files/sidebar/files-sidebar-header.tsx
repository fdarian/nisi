import { EllipsisIcon, PanelLeftCloseIcon, SearchIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import type { SidebarViewMode } from "#/features/settings/settings-data";
import { SidebarIconButton, SidebarTooltip } from "./sidebar-icon-button";

export function FilesSidebarHeader(props: {
	fileCount: number;
	viewMode: SidebarViewMode;
	onViewModeChange: (viewMode: SidebarViewMode) => void;
	hideReviewed: boolean;
	onHideReviewedChange: (hideReviewed: boolean) => void;
	onSearch: () => void;
	onCollapseSidebar: () => void;
	onCollapseAllFolders: () => void;
	onExpandAllFolders: () => void;
}): React.ReactElement {
	return (
		<div className="flex h-9 shrink-0 items-center justify-between pl-2">
			<span className="text-muted-foreground text-xs">
				{props.fileCount} {props.fileCount === 1 ? "file" : "files"}
			</span>
			<div className="flex items-center gap-0.5">
				<SidebarIconButton
					icon={<SearchIcon />}
					keepFocus
					label="Filter files"
					onClick={props.onSearch}
					shortcut="⌘F"
				/>
				<DropdownMenu>
					<SidebarTooltip label="More">
						<DropdownMenuTrigger
							render={
								<Button aria-label="More" size="icon-xs" variant="ghost">
									<EllipsisIcon />
								</Button>
							}
						/>
					</SidebarTooltip>
					<DropdownMenuContent align="end">
						<DropdownMenuCheckboxItem
							checked={props.hideReviewed}
							onCheckedChange={props.onHideReviewedChange}
						>
							Hide reviewed
						</DropdownMenuCheckboxItem>
						<DropdownMenuSeparator />
						<DropdownMenuRadioGroup
							onValueChange={(value) => {
								if (value === "tree" || value === "flat")
									props.onViewModeChange(value);
							}}
							value={props.viewMode}
						>
							<DropdownMenuRadioItem closeOnClick value="tree">
								Tree
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem closeOnClick value="flat">
								Flat
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						{props.viewMode === "tree" && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem onClick={props.onCollapseAllFolders}>
									Collapse all folders
								</DropdownMenuItem>
								<DropdownMenuItem onClick={props.onExpandAllFolders}>
									Expand all folders
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				<SidebarIconButton
					icon={<PanelLeftCloseIcon />}
					label="Collapse sidebar"
					onClick={props.onCollapseSidebar}
					shortcut="⌘B"
				/>
			</div>
		</div>
	);
}
