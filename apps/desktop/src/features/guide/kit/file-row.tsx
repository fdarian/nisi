"use client";

import { cn } from "cn";
import { ChevronRightIcon } from "lucide-react";
import { Checkbox } from "#/components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import type { RangeReviewStatus } from "#/features/diff/review-coverage";
import { useAreaScope, useGuideContext } from "../guide-context";
import { sameRef } from "../refs";
import { DiffStat } from "./diff-stat";

/** A row's Reviewed checkbox. `status` is `undefined` while a hunk row's file contents are still loading. */
export type FileRowReview = {
	status: RangeReviewStatus | undefined;
	onToggle: (viewed: boolean) => void;
};

/** Makes a row the parent of its file's claimed hunk rows: the count toggles them open beneath it. */
export type FileRowGroup = {
	hunkCount: number;
	open: boolean;
	onToggle: () => void;
};

/**
 * One line of a changed-file list: a ghost button, label on the left and +/−
 * on the right, that opens the file (or the hunk, when `lines` is set) in the
 * side pane, then the Reviewed checkbox. The tooltip carries the full path.
 */
export function FileRow(props: {
	path: string;
	lines?: string;
	label: string;
	additions: number;
	deletions: number;
	review?: FileRowReview;
	group?: FileRowGroup;
}): React.ReactElement {
	const guide = useGuideContext();
	const scope = useAreaScope();
	const selected = sameRef(guide.selectedRef, {
		path: props.path,
		lines: props.lines,
	});
	const reviewed = props.review?.status === "reviewed";
	const stat = (
		<span className="shrink-0 font-mono text-xs tabular-nums">
			<DiffStat additions={props.additions} deletions={props.deletions} />
		</span>
	);
	return (
		<div
			data-text="inline"
			className={cn(
				"flex w-full min-w-0 items-center gap-1 rounded-md pr-1.5 hover:bg-accent",
				selected && "bg-sky-500/10",
			)}
		>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							className="flex min-w-0 flex-1 cursor-pointer items-center justify-between gap-3 rounded-md py-1 pl-1.5 text-left"
							onClick={() =>
								guide.selectRef({ path: props.path, lines: props.lines }, scope)
							}
							type="button"
						>
							<span
								className={cn(
									"truncate font-mono text-sky-600 text-xs dark:text-sky-400",
									reviewed && "opacity-50",
								)}
								data-text="ref"
							>
								{props.label}
							</span>
							{props.group === undefined && stat}
						</button>
					}
				/>
				<TooltipPopup>
					<span className="font-mono">
						{props.lines === undefined
							? props.path
							: `${props.path}:${props.lines}`}
					</span>
				</TooltipPopup>
			</Tooltip>
			{props.group !== undefined && (
				<>
					<button
						aria-expanded={props.group.open}
						className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded px-1 py-1 text-muted-foreground text-xs tabular-nums"
						onClick={props.group.onToggle}
						type="button"
					>
						<span aria-hidden>·</span> {props.group.hunkCount} hunks
						<ChevronRightIcon
							className={cn(
								"size-3 transition-transform",
								props.group.open && "rotate-90",
							)}
						/>
					</button>
					{stat}
				</>
			)}
			{props.review !== undefined && (
				<Checkbox
					aria-label={`Mark ${props.label} reviewed`}
					checked={reviewed}
					disabled={props.review.status === undefined}
					indeterminate={props.review.status === "partial"}
					onCheckedChange={(checked) => props.review?.onToggle(checked)}
				/>
			)}
		</div>
	);
}
