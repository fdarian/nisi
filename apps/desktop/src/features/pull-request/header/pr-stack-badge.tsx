"use client";

import {
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	LayersIcon,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { Frame, FramePanel } from "#/components/ui/frame";
import {
	Popover,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "#/components/ui/popover";
import type { PullRequestStackEntry } from "#/features/pull-request/data/pr-data";
import { usePullRequestStack } from "#/features/pull-request/data/pr-data";
import {
	type OpenPullRequestParams,
	useOpenPullRequest,
} from "#/features/pull-request/data/pull-requests-data";
import { useDismissOnInactive } from "#/features/pull-request/use-dismiss-on-inactive";
import type { SidecarQueryUtils } from "#/infra/backend-context";

type PrStackBadgeProps = {
	orpc: SidecarQueryUtils;
	owner: string;
	repo: string;
	number: number;
	watched: boolean;
	findExistingSessionId: (params: OpenPullRequestParams) => string | undefined;
	onSessionOpened: (sessionId: string) => void;
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
			className="relative min-w-0 border-l-2 pl-1 pr-1.5 data-[iscurrent=true]:border-l-blue-500 border-l-transparent"
			data-iscurrent={props.isCurrent}
		>
			<div
				className="data-[iscurrent=true]:bg-blue-500/10 hover:bg-muted/60 rounded-md flex items-start gap-2 py-1.5 px-2"
				data-iscurrent={props.isCurrent}
			>
				{props.showConnector && (
					<div className="absolute top-[calc(--spacing(5)+--spacing(1.5)+--spacing(1))] -bottom-[calc(--spacing(1.5)-_--spacing(1))] flex w-5 justify-center">
						<span className="w-px bg-border" />
					</div>
				)}
				<span className="relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center">
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
		</div>
	);

	if (props.isCurrent) return content;
	return (
		<button
			className="block w-full cursor-pointer text-left"
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
	const [open, setOpen] = useDismissOnInactive(props.watched);
	const stackQuery = usePullRequestStack(props.orpc, {
		owner: props.owner,
		repo: props.repo,
		number: props.number,
	});
	const openPullRequest = useOpenPullRequest(props.orpc, props.onSessionOpened);
	const stack = stackQuery.data;
	if (stack === undefined || stack === null) return null;

	const entries = [...stack.entries].sort(
		(left, right) => right.position - left.position,
	);

	return (
		<>
			<span aria-hidden="true">&middot;</span>
			<Popover onOpenChange={setOpen} open={open}>
				<PopoverTrigger
					aria-label={`Stack position ${stack.position} of ${stack.size}`}
					className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
					render={(props) => (
						<Button variant="secondary" size="xs" {...props}>
							<LayersIcon aria-hidden="true" />
							{stack.position}/{stack.size}
						</Button>
					)}
				/>
				<PopoverPopup className="rounded-2xl w-80" viewportClassName="p-0">
					<Frame>
						<FramePanel className="px-0 pt-4 pb-1.5">
							<PopoverTitle className="mb-4 text-sm px-4">
								Stack #{stack.number}
							</PopoverTitle>
							{entries.map((entry) => (
								<StackEntryRow
									entry={entry}
									isCurrent={entry.number === props.number}
									key={entry.number}
									onOpen={() => {
										if (openPullRequest.isPending) return;
										const params = {
											owner: props.owner,
											repo: props.repo,
											number: entry.number,
										};
										const existingSessionId =
											props.findExistingSessionId(params);
										if (existingSessionId !== undefined) {
											props.onSessionOpened(existingSessionId);
											setOpen(false);
											return;
										}
										openPullRequest.open(params);
										setOpen(false);
									}}
									showConnector
								/>
							))}
							<div className="flex items-center gap-2 pl-3.5 py-2">
								<div className="w-5 flex justify-center">
									<span className="size-3 shrink-0 rounded-full border border-muted-foreground" />
								</div>
								<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
									{stack.baseRefName}
								</span>
							</div>
						</FramePanel>
					</Frame>
				</PopoverPopup>
			</Popover>
		</>
	);
}
