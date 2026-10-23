import { PanelLeftOpenIcon, SearchIcon } from "lucide-react";
import { SidebarIconButton } from "./sidebar-icon-button";

export function FilesSidebarRail(props: {
	onExpand: () => void;
	onSearch: () => void;
}): React.ReactElement {
	return (
		<div className="flex h-full w-10 shrink-0 flex-col items-center gap-1 bg-pane-surface-nested py-2">
			<SidebarIconButton
				icon={<PanelLeftOpenIcon />}
				label="Expand sidebar"
				onClick={props.onExpand}
			/>
			<SidebarIconButton
				icon={<SearchIcon />}
				label="Filter files"
				onClick={props.onSearch}
				shortcut="⌘F"
			/>
		</div>
	);
}
