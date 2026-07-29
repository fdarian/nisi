import { FileIcon, MoreHorizontalIcon } from "lucide-react";
import type { BadgeProps } from "#/components/ui/badge";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import type { FileChange, FileStatus, ReviewState } from "#/lib/pr-data";
import { splitPath } from "#/lib/tree-paths";
import { cn } from "#/lib/utils";

const STATUS_LABEL: Record<FileStatus, string> = {
	added: "Added",
	deleted: "Deleted",
	modified: "Modified",
	renamed: "Renamed",
};

const STATUS_VARIANT: Record<FileStatus, BadgeProps["variant"]> = {
	added: "success",
	deleted: "error",
	modified: "info",
	renamed: "outline",
};

type DiffFileHeaderProps = {
	file: FileChange;
	reviewStatus: ReviewState;
	viewed: boolean;
	onToggleViewed: () => void;
};

/**
 * The `renderCustomHeader` content for one file's diff card — plain light-DOM
 * React, slotted into the `<diffs-container>` custom element that
 * `diff-pane.tsx` styles as a card (see its `[&_diffs-container]` classes).
 * This is that card's header row, so it carries its own `bg-card`/`border-b`
 * rather than staying transparent — the diff body below shares `--code`,
 * which resolves to the same tone as `--card` in both themes (see
 * `index.css`), so the two read as one continuous surface split by the rule.
 */
export function DiffFileHeader({
	file,
	reviewStatus,
	viewed,
	onToggleViewed,
}: DiffFileHeaderProps): React.ReactElement {
	const { dirname, basename } = splitPath(file.path);

	return (
		<div className="flex min-w-0 flex-1 items-center gap-3 border-b bg-card px-3 py-2">
			<FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate font-mono text-xs">
				{dirname && (
					<span className="truncate text-muted-foreground">{dirname}/</span>
				)}
				<span className="truncate font-medium text-foreground">{basename}</span>
				{file.oldPath && (
					<span className="truncate text-muted-foreground text-[0.6875rem]">
						← {file.oldPath}
					</span>
				)}
			</span>
			<Badge size="sm" variant={STATUS_VARIANT[file.status]}>
				{STATUS_LABEL[file.status]}
			</Badge>
			{reviewStatus === "changed-after-review" && (
				<Badge size="sm" variant="warning">
					Modified after review
				</Badge>
			)}
			<span className="shrink-0 font-mono text-xs tabular-nums">
				<span className="text-success-foreground">+{file.additions}</span>{" "}
				<span className="text-destructive-foreground">-{file.deletions}</span>
			</span>
			<label
				className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted-foreground text-xs"
				htmlFor={`reviewed-${file.path}`}
			>
				<Checkbox
					checked={viewed}
					id={`reviewed-${file.path}`}
					onCheckedChange={() => onToggleViewed()}
					onClick={(event) => event.stopPropagation()}
				/>
				Reviewed
			</label>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="File actions"
					className={cn(
						buttonVariants({ variant: "ghost", size: "icon-sm" }),
						"shrink-0",
					)}
					onClick={(event: React.MouseEvent<HTMLButtonElement>) =>
						event.stopPropagation()
					}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem
						onClick={() => navigator.clipboard.writeText(file.path)}
					>
						Copy path
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
