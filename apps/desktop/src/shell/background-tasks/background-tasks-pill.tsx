"use client";

import { Loader2Icon } from "lucide-react";
import type React from "react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { MergeMethod } from "#/features/pull-request/data/pr-data";
import {
	type BackgroundTask,
	backgroundTaskKey,
	type ScheduledMergeTask,
} from "./background-tasks-data";

const METHOD_LABEL: Record<MergeMethod, string> = {
	merge: "merge commit",
	squash: "squash",
	rebase: "rebase",
};

function statusLine(task: BackgroundTask): string {
	if (task.kind === "merging")
		return task.route === "stack" ? "Merging stack…" : "Merging…";
	const prefix = task.route === "stack" ? "Stack merges" : "Merges";
	return `${prefix} when checks pass · ${METHOD_LABEL[task.method]}`;
}

/** Renders nothing when there are no tasks; the connected wrapper owns where the data comes from. */
export function BackgroundTasksPill(props: {
	tasks: readonly BackgroundTask[];
	onStop: (task: ScheduledMergeTask) => void;
	/** Keys (`backgroundTaskKey`) of tasks whose stop request is in flight. */
	stoppingKeys: ReadonlySet<string>;
	defaultOpen?: boolean;
}): React.ReactElement | null {
	if (props.tasks.length === 0) return null;

	return (
		<Popover defaultOpen={props.defaultOpen}>
			<PopoverTrigger
				aria-label={`${props.tasks.length} background ${props.tasks.length === 1 ? "task" : "tasks"}`}
				render={(triggerProps) => (
					<Button
						{...triggerProps}
						className="gap-1.5 self-center rounded-full before:rounded-full"
						size="xs"
						variant="outline"
					>
						<Loader2Icon className="animate-spin" />
						<span className="font-medium tabular-nums">
							{props.tasks.length}
						</span>
					</Button>
				)}
			/>
			<PopoverPopup
				align="end"
				className="w-96"
				viewportClassName="py-1 [--viewport-inline-padding:--spacing(1)]"
			>
				<PopoverTitle className="px-2 pt-2 pb-1 font-medium text-sm">
					Background tasks
				</PopoverTitle>
				<ul className="flex flex-col">
					{props.tasks.map((task) => (
						<li
							className="flex items-center gap-3 rounded-md px-2 py-1.5"
							key={backgroundTaskKey(task)}
						>
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<span className="truncate text-sm">
									<span className="font-medium">
										{task.owner}/{task.repo}#{task.number}
									</span>
									{task.title === undefined ? null : (
										<span className="text-muted-foreground"> {task.title}</span>
									)}
								</span>
								<span className="text-muted-foreground text-xs">
									{statusLine(task)}
								</span>
							</div>
							{task.kind === "scheduled-merge" ? (
								<Button
									loading={props.stoppingKeys.has(backgroundTaskKey(task))}
									onClick={() => props.onStop(task)}
									size="xs"
									variant="outline"
								>
									Stop
								</Button>
							) : (
								<span className="shrink-0 text-muted-foreground text-xs">
									Can't be stopped
								</span>
							)}
						</li>
					))}
				</ul>
			</PopoverPopup>
		</Popover>
	);
}
