"use client";

import { cn } from "cn";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import { useGuideContext } from "../guide-context";
import { sameRef } from "../refs";
import { DiffStat } from "./diff-stat";

/**
 * One line of a changed-file list: a full-width ghost button, label on the
 * left and +/− on the right, that opens the file (or the hunk, when `lines`
 * is set) in the side pane. The tooltip carries the full path.
 */
export function FileRow(props: {
	path: string;
	lines?: string;
	label: string;
	additions: number;
	deletions: number;
}): React.ReactElement {
	const guide = useGuideContext();
	const selected = sameRef(guide.selectedRef, {
		path: props.path,
		lines: props.lines,
	});
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						className={cn(
							"flex w-full min-w-0 cursor-pointer items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left hover:bg-accent",
							selected && "bg-sky-500/10",
						)}
						onClick={() =>
							guide.selectRef({ path: props.path, lines: props.lines })
						}
						type="button"
					>
						<span
							className="truncate font-mono text-sky-600 text-xs dark:text-sky-400"
							data-text="ref"
						>
							{props.label}
						</span>
						<span className="shrink-0 font-mono text-xs tabular-nums">
							<DiffStat
								additions={props.additions}
								deletions={props.deletions}
							/>
						</span>
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
	);
}
