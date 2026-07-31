import {
	ChevronDownIcon,
	ChevronRightIcon,
	FileIcon,
	MoreHorizontalIcon,
} from "lucide-react";
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
	/** Whether this file's card currently shows header-only — see `diff-pane.tsx`'s `fileCollapseOverrides`. */
	collapsed: boolean;
	onToggleCollapse: () => void;
};

/**
 * The `renderCustomHeader` content for one file's diff card — plain light-DOM
 * React, slotted into the `<diffs-container>` custom element that
 * `diff-pane.tsx` styles as a card (see its `[&_diffs-container]` classes).
 * This is that card's header row, so it carries its own opaque background
 * (`stickyHeaders` scrolls content underneath it) plus the `border-b` that
 * separates it from the diff body. `bg-background`, not `bg-card`: the whole
 * card tracks the surrounding panel's tone — `--card` is measurably lighter
 * than `--background` in dark mode (index.css) — so the header, the
 * `<diffs-container>` behind it (`diff-pane.tsx`) and the diff body
 * (`diff-view-theme.ts`'s `--diffs-light-bg`/`--diffs-dark-bg`) all resolve
 * to the same surface, and the border here is a seam drawn on it rather than
 * a change of tone.
 *
 * `h-11` (44px) is load-bearing, not a style preference — it must equal
 * `diffItemMetrics.diffHeaderHeight` (`diff-view-theme.ts`). `stickyHeaders`
 * never measures this header's real DOM height; it trusts that config number
 * for the sticky container's own CSS offset and for sizing its virtualized
 * render buffer (`@pierre/diffs`' `CodeView.js` — the sticky wrapper's own
 * `bottom` offset is `itemMetrics.diffHeaderHeight`, literally, not a
 * measurement). Letting this row's real height drift from 44px — e.g. content
 * wrapping, or the "Modified after review" badge making some files' headers
 * taller than others' — feeds pierre a wrong offset: the sticky header stops
 * covering content a few pixels early or late (rows visible through/behind
 * it), and the buffer window sizes itself off the same wrong number (a
 * scroll stutter that stalls a frame then jumps, worse the more scrolling
 * this file needs). `items-center` plus `truncate` on the path spans below
 * keep this a fixed one-line row regardless of path length, so 44px is safe
 * to hard-code rather than measure.
 */
export function DiffFileHeader({
	file,
	reviewStatus,
	viewed,
	onToggleViewed,
	collapsed,
	onToggleCollapse,
}: DiffFileHeaderProps): React.ReactElement {
	const { dirname, basename } = splitPath(file.path);

	return (
		// biome-ignore lint/a11y/useSemanticElements: can't be a real <button> — it hosts the Reviewed <label>/<Checkbox> and the "…" dropdown trigger, controls a nested <button> would break.
		<div
			aria-expanded={!collapsed}
			className="flex h-11 min-w-0 flex-1 cursor-pointer items-center gap-3 border-b bg-background px-3"
			onClick={onToggleCollapse}
			onKeyDown={(event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				onToggleCollapse();
			}}
			role="button"
			tabIndex={0}
		>
			{collapsed ? (
				<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
			) : (
				<ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
			)}
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
				className={cn(
					buttonVariants({ variant: "ghost", size: "sm" }),
					"shrink-0 text-muted-foreground",
				)}
				htmlFor={`reviewed-${file.path}`}
				onClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
			>
				<Checkbox
					checked={viewed}
					id={`reviewed-${file.path}`}
					onCheckedChange={() => onToggleViewed()}
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
					onKeyDown={(event: React.KeyboardEvent<HTMLButtonElement>) =>
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
