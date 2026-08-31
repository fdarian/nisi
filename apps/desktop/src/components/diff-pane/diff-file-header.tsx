import {
	ChevronDownIcon,
	ChevronRightIcon,
	FileIcon,
	MoreHorizontalIcon,
} from "lucide-react";
import { diffCardHeaderClassName } from "#/components/diff-pane/diff-view-theme";
import type { BadgeProps } from "#/components/ui/badge";
import { Badge } from "#/components/ui/badge";
import { buttonVariants } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import {
	openInEditor,
	useAvailableEditors,
} from "#/hooks/use-available-editors";
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
	/** The session's repo root — joined with `file.path` for "Copy absolute path". */
	repoRoot: string;
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
 * This is that card's header row, so it carries the card's whole top edge —
 * rounded corners included, since it stays pinned at the pane's top long
 * after the container's own corners have scrolled away. The edge itself
 * (height, border, background, rounding) is `diffCardHeaderClassName`
 * (`diff-view-theme.ts` — see its doc comment for why the height is
 * load-bearing rather than a style choice, shared with `diffCardChromeCSS`,
 * which draws the other three edges); this component owns only the row's
 * content layout and click-to-collapse behavior. `items-center` plus
 * `truncate` on the path spans below keep this a fixed one-line row
 * regardless of path length, which is what makes the shared 44px height safe
 * to hard-code rather than measure.
 */
export function DiffFileHeader({
	file,
	repoRoot,
	reviewStatus,
	viewed,
	onToggleViewed,
	collapsed,
	onToggleCollapse,
}: DiffFileHeaderProps): React.ReactElement {
	const { dirname, basename } = splitPath(file.path);
	const { editors, loadEditors } = useAvailableEditors();
	const absolutePath = `${repoRoot}/${file.path}`;

	return (
		// biome-ignore lint/a11y/useSemanticElements: can't be a real <button> — it hosts the Reviewed <label>/<Checkbox> and the "…" dropdown trigger, controls a nested <button> would break.
		<div
			aria-expanded={!collapsed}
			className={cn(
				"flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3",
				diffCardHeaderClassName(collapsed),
			)}
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
			<DropdownMenu
				onOpenChange={(open) => {
					if (open) loadEditors();
				}}
			>
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
					<DropdownMenuItem
						onClick={() => navigator.clipboard.writeText(absolutePath)}
					>
						Copy absolute path
					</DropdownMenuItem>
					{editors.length > 0 && (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Open in...</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{editors.map((editor) => (
									<DropdownMenuItem
										key={editor.id}
										onClick={() =>
											openInEditor(
												editor.id,
												editor.name,
												repoRoot,
												absolutePath,
											)
										}
									>
										{editor.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
