"use client";

import {
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	LayersIcon,
} from "lucide-react";
import { useState } from "react";
import {
	Popover,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { PullRequestStackEntry } from "#/lib/pr-data";
import { usePullRequestStack } from "#/lib/pr-data";
import { useOpenPullRequest } from "#/lib/pull-requests-data";

type PrStackBadgeProps = {
	orpc: SidecarQueryUtils;
	owner: string;
	repo: string;
	number: number;
	watched: boolean;
};

const stateIconClass = (entry: PullRequestStackEntry): string => {
	if (entry.isDraft) return "text-muted-foreground";
	switch (entry.state) {
		case "OPEN":
			return "text-success-foreground";
		case "MERGED":
			return "text-purple-500";
		case "CLOSED":
			return "text-destructive-foreground";
	}
};

function StateIcon({
	entry,
}: {
	entry: PullRequestStackEntry;
}): React.ReactElement {
	const className = `size-4 shrink-0 ${stateIconClass(entry)}`;
	if (entry.isDraft) return <GitPullRequestDraftIcon className={className} />;
	switch (entry.state) {
		case "OPEN":
			return <GitPullRequestIcon className={className} />;
		case "MERGED":
			return <GitMergeIcon className={className} />;
		case "CLOSED":
			return <GitPullRequestClosedIcon className={className} />;
	}
}

function StackEntryRow(props: {
	entry: PullRequestStackEntry;
	isCurrent: boolean;
	showConnector: boolean;
	onOpen: () => void;
}): React.ReactElement {
	const content = (
		<div
			className={`relative flex min-w-0 items-start gap-2 border-l-2 px-2 py-1.5 ${
				props.isCurrent
					? "border-l-blue-500 bg-blue-500/10"
					: "border-l-transparent"
			}`}
		>
			{props.showConnector && (
				<span className="absolute top-6 bottom-[-0.5rem] left-[0.6875rem] w-px bg-border" />
			)}
			<span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center bg-popover">
				<StateIcon entry={props.entry} />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate font-semibold text-sm">
					{props.entry.title}
				</span>
				<span className="block truncate text-muted-foreground text-xs">
					#{props.entry.number} · {props.entry.headRefName}
				</span>
			</span>
		</div>
	);

	if (props.isCurrent) return content;
	return (
		<button
			className="block w-full cursor-pointer text-left hover:bg-muted/60"
			onClick={props.onOpen}
			type="button"
		>
			{content}
		</button>
	);
}

/** A compact breadcrumb badge and read-only stack navigator for stacked PRs. */
export function PrStackBadge(
	props: PrStackBadgeProps,
): React.ReactElement | null {
	const [open, setOpen] = useState(false);
	const stackQuery = usePullRequestStack(
		props.orpc,
		{ owner: props.owner, repo: props.repo, number: props.number },
		props.watched,
	);
	const openPullRequest = useOpenPullRequest(props.orpc, () => undefined);
	const stack = stackQuery.data;
	if (stack === undefined || stack === null) return null;

	const entries = [...stack.entries].sort(
		(left, right) => right.position - left.position,
	);

	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				aria-label={`Stack position ${stack.position} of ${stack.size}`}
				className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
				type="button"
			>
				<span aria-hidden="true">・</span>
				<span className="font-mono tabular-nums">
					{stack.position}/{stack.size}
				</span>
				<LayersIcon className="size-3.5" />
			</PopoverTrigger>
			<PopoverPopup align="start" className="w-80">
				<PopoverTitle className="mb-3 text-sm">
					Stack #{stack.number}
				</PopoverTitle>
				<div className="flex flex-col">
					{entries.map((entry, index) => (
						<StackEntryRow
							entry={entry}
							isCurrent={entry.number === props.number}
							key={entry.number}
							onOpen={() => {
								if (openPullRequest.isPending) return;
								openPullRequest.open({
									owner: props.owner,
									repo: props.repo,
									number: entry.number,
								});
								setOpen(false);
							}}
							showConnector={index < entries.length - 1}
						/>
					))}
					<div className="mt-2 flex items-center gap-2 border-t px-2 pt-2">
						<span className="size-3 shrink-0 rounded-full border border-muted-foreground" />
						<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
							{stack.baseRefName}
						</span>
					</div>
				</div>
			</PopoverPopup>
		</Popover>
	);
}
