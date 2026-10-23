import { PanelLeftOpenIcon, SearchIcon } from "lucide-react";
import { SidebarIconButton } from "./sidebar-icon-button";

export function FilesSidebarRail(props: {
	onExpand: () => void;
	onSearch: () => void;
}): React.ReactElement {
	return (
		<div className="flex h-full w-full flex-col px-diff-pane-inset">
			{/* Same row geometry as the panel header, so the Expand and Collapse icons share a y. */}
			<div className="flex h-9 shrink-0 items-center">
				<SidebarIconButton
					handoffAnchor
					icon={<PanelLeftOpenIcon />}
					label="Expand sidebar"
					onClick={props.onExpand}
					shortcut="⌘B"
				/>
			</div>
			<div className="-mt-0.5">
				<SidebarIconButton
					icon={<SearchIcon />}
					label="Filter files"
					onClick={props.onSearch}
					shortcut="⌘F"
				/>
			</div>
		</div>
	);
}
