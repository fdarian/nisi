import { FileIcon, MousePointerClickIcon } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";

/**
 * Stands in for the real diff pane (next wave). Selection state and the
 * eventual "scroll to file" hookup already exist one level up in
 * `FilesChangedView` — this component is the clean seam a real diff pane
 * drops into, keyed by `selectedPath`.
 */
export function DiffPanePlaceholder({
	selectedPath,
}: {
	selectedPath: string | null;
}): React.ReactElement {
	if (selectedPath == null) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<MousePointerClickIcon />
				</EmptyMedia>
				<EmptyTitle>No file selected</EmptyTitle>
				<EmptyDescription>
					Pick a file from the sidebar to preview it here.
				</EmptyDescription>
			</Empty>
		);
	}

	return (
		<div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
			<FileIcon className="size-6 text-muted-foreground" />
			<p className="max-w-md break-all font-mono text-sm">{selectedPath}</p>
			<p className="text-muted-foreground text-xs">
				Diff view lands next phase — this is a placeholder.
			</p>
		</div>
	);
}
