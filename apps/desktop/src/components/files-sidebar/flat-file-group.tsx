import { FileIcon } from "lucide-react";
import { GroupHeader } from "#/components/files-sidebar/group-header";
import type { FileChange, ReviewState, ReviewStateEntry } from "#/lib/pr-data";
import { splitPath } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

type FlatFileGroupProps = {
	title: string;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
};

/** Flat mode has no library to lean on — `@pierre/trees` has no flat option — so this is a plain, hand-rolled list mirroring the same row language as the tree (muted-viewed, orange-dot-changed, click-to-select). */
export function FlatFileGroup({
	title,
	files,
	reviewState,
	selectedPath,
	onSelectPath,
}: FlatFileGroupProps): React.ReactElement {
	return (
		<div>
			<GroupHeader title={title} count={files.length} />
			<ul>
				{files.map((file) => (
					<FlatFileRow
						key={file.path}
						file={file}
						reviewState={reviewState.get(file.path)?.status ?? "unreviewed"}
						selected={file.path === selectedPath}
						onSelectPath={onSelectPath}
					/>
				))}
			</ul>
		</div>
	);
}

function FlatFileRow({
	file,
	reviewState,
	selected,
	onSelectPath,
}: {
	file: FileChange;
	reviewState: ReviewState;
	selected: boolean;
	onSelectPath: (path: string) => void;
}): React.ReactElement {
	const { dirname, basename } = splitPath(file.path);
	const viewed = reviewState === "viewed";

	return (
		<li>
			<button
				className={cn(
					"flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
					"hover:bg-sidebar-accent",
					selected && "bg-sidebar-accent text-sidebar-accent-foreground",
					viewed && "text-muted-foreground",
				)}
				data-item-path={file.path}
				onClick={() => onSelectPath(file.path)}
				type="button"
			>
				<FileIcon
					className={cn("size-3.5 shrink-0", viewed && "text-muted-foreground")}
				/>
				<span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
					{dirname && (
						<span className="truncate text-muted-foreground text-xs">
							{dirname}/
						</span>
					)}
					<span className="truncate">{basename}</span>
				</span>
				{reviewState === "changed-after-review" && (
					<span
						className="size-1.5 shrink-0 rounded-full bg-orange-500"
						role="img"
						aria-label="Changed after review"
						title="Changed after review"
					/>
				)}
			</button>
		</li>
	);
}
