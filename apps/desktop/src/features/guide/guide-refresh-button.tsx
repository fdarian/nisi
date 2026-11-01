import { RefreshCwIcon } from "lucide-react";
import { Button } from "#/components/ui/button";

/** The Guide has no Files Changed toolbar while no diff pane is open, so a newer head is offered as a corner icon. Zero height so it never shifts the guide; renders nothing while the file list is current. */
export function GuideRefreshButton(props: {
	hasPendingChanges: boolean;
	onRefresh: () => void;
}): React.ReactElement | null {
	if (!props.hasPendingChanges) return null;
	return (
		<div className="sticky top-0 z-10 flex h-0 justify-end">
			<Button
				aria-label="Refresh"
				onClick={props.onRefresh}
				size="icon-sm"
				title="Refresh"
				variant="warning-secondary"
			>
				<RefreshCwIcon />
			</Button>
		</div>
	);
}
