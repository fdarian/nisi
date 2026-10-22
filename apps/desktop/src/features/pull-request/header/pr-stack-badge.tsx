"use client";

import { isDefinedError } from "@orpc/client";
import {
	GitMergeIcon,
	GitPullRequestClosedIcon,
	GitPullRequestDraftIcon,
	GitPullRequestIcon,
	LayersIcon,
	LayersPlusIcon,
} from "lucide-react";
import { Button } from "#/components/ui/button";
import { Frame, FramePanel } from "#/components/ui/frame";
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "#/components/ui/popover";
import type {
	CreatePullRequestStackError,
	PullRequestStackEntry,
} from "#/features/pull-request/data/pr-data";
import {
	useCreatePullRequestStack,
	usePullRequestStack,
	usePullRequestStackSuggestion,
} from "#/features/pull-request/data/pr-data";
import {
	type OpenPullRequestParams,
	useOpenPullRequest,
} from "#/features/pull-request/data/pull-requests-data";
import { OriginMovedDialog } from "#/features/pull-request/open/origin-moved-dialog";
import { useDismissOnInactive } from "#/features/pull-request/use-dismiss-on-inactive";
import type { SidecarQueryUtils } from "#/infra/backend-context";

type PrStackBadgeProps = {
	orpc: SidecarQueryUtils;
	owner: string;
	repo: string;
	number: number;
	watched: boolean;
	isSelectedTab: boolean;
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

/** The entry rows (newest position first, joined by connector lines) and the base-branch footer, shared by the real stack and the suggestion. */
function StackList(props: {
	entries: readonly PullRequestStackEntry[];
	baseRefName: string;
	currentNumber: number;
	onOpenEntry: (number: number) => void;
}): React.ReactElement {
	const entries = [...props.entries].sort(
		(left, right) => right.position - left.position,
	);

	return (
		<>
			{entries.map((entry) => (
				<StackEntryRow
					entry={entry}
					isCurrent={entry.number === props.currentNumber}
					key={entry.number}
					onOpen={() => props.onOpenEntry(entry.number)}
					showConnector
				/>
			))}
			<div className="flex items-center gap-2 pl-3.5 py-2">
				<div className="w-5 flex justify-center">
					<span className="size-3 shrink-0 rounded-full border border-muted-foreground" />
				</div>
				<span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground text-xs">
					{props.baseRefName}
				</span>
			</div>
		</>
	);
}

const createStackFailureMessage = (
	error: CreatePullRequestStackError,
): { reason: string; detail: string } => {
	if (isDefinedError(error) && error.code !== "UNAUTHORIZED") {
		return { reason: error.data.reason, detail: error.data.detail };
	}
	return {
		reason: "Couldn't create the stack",
		detail: error instanceof Error ? error.message : String(error),
	};
};

function CreateStackFooter(props: {
	isPending: boolean;
	error: CreatePullRequestStackError | null;
	onCreate: () => void;
}): React.ReactElement {
	const failure =
		props.error === null ? null : createStackFailureMessage(props.error);

	return (
		<div className="mt-1 flex flex-col gap-2 px-4 pt-2 pb-2.5">
			{failure !== null && (
				<div className="text-xs" role="alert">
					<p className="font-medium text-destructive-foreground">
						{failure.reason}
					</p>
					<p className="mt-0.5 break-words text-muted-foreground">
						{failure.detail}
					</p>
				</div>
			)}
			<div className="flex justify-end">
				<Button loading={props.isPending} onClick={props.onCreate} size="sm">
					Create stack
				</Button>
			</div>
		</div>
	);
}

function StackPopover(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	ariaLabel: string;
	triggerVariant: "secondary" | "ghost";
	triggerSize: "xs" | "icon-xs";
	triggerContent: React.ReactNode;
	title: string;
	description?: string;
	entries: readonly PullRequestStackEntry[];
	baseRefName: string;
	currentNumber: number;
	onOpenEntry: (number: number) => void;
	footer?: React.ReactNode;
}): React.ReactElement {
	return (
		<Popover onOpenChange={props.onOpenChange} open={props.open}>
			<PopoverTrigger
				aria-label={props.ariaLabel}
				className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
				render={(triggerProps) => (
					<Button
						variant={props.triggerVariant}
						size={props.triggerSize}
						{...triggerProps}
					>
						{props.triggerContent}
					</Button>
				)}
			/>
			<PopoverPopup className="rounded-2xl w-80" viewportClassName="p-0">
				<Frame>
					<FramePanel className="px-0 pt-4 pb-1.5">
						<PopoverTitle className="text-sm px-4">{props.title}</PopoverTitle>
						{props.description !== undefined && (
							<PopoverDescription className="mt-1 px-4 text-muted-foreground text-xs">
								{props.description}
							</PopoverDescription>
						)}
						<div className="mt-4">
							<StackList
								baseRefName={props.baseRefName}
								currentNumber={props.currentNumber}
								entries={props.entries}
								onOpenEntry={props.onOpenEntry}
							/>
						</div>
						{props.footer}
					</FramePanel>
				</Frame>
			</PopoverPopup>
		</Popover>
	);
}

/** A compact badge beside the PR number and read-only stack navigator for stacked PRs; for a PR GitHub hasn't stacked, an icon-only trigger offers the inferred chain. */
export function PrStackBadge(
	props: PrStackBadgeProps,
): React.ReactElement | null {
	const [open, setOpen] = useDismissOnInactive(props.watched);
	const params = {
		owner: props.owner,
		repo: props.repo,
		number: props.number,
	};
	const stackQuery = usePullRequestStack(
		props.orpc,
		params,
		props.isSelectedTab,
	);
	const stack = stackQuery.data;
	const suggestionQuery = usePullRequestStackSuggestion(
		props.orpc,
		params,
		props.isSelectedTab && stack === null,
	);
	const suggestion = stack === null ? suggestionQuery.data : undefined;
	const openPullRequest = useOpenPullRequest(props.orpc, props.onSessionOpened);
	const createStack = useCreatePullRequestStack(props.orpc);

	const openEntry = (number: number) => {
		if (openPullRequest.isPending) return;
		const entryParams = { ...params, number };
		const existingSessionId = props.findExistingSessionId(entryParams);
		if (existingSessionId !== undefined) {
			props.onSessionOpened(existingSessionId);
			setOpen(false);
			return;
		}
		openPullRequest.open(entryParams);
		setOpen(false);
	};

	if (stack !== undefined && stack !== null) {
		return (
			<>
				<OriginMovedDialog prompt={openPullRequest.originMoved} />
				<span aria-hidden="true">&middot;</span>
				<StackPopover
					ariaLabel={`Stack position ${stack.position} of ${stack.size}`}
					baseRefName={stack.baseRefName}
					currentNumber={props.number}
					entries={stack.entries}
					onOpenChange={setOpen}
					onOpenEntry={openEntry}
					open={open}
					title={`Stack #${stack.number}`}
					triggerContent={
						<>
							<LayersIcon aria-hidden="true" />
							{stack.position}/{stack.size}
						</>
					}
					triggerSize="xs"
					triggerVariant="secondary"
				/>
			</>
		);
	}

	if (suggestion === undefined || suggestion === null) return null;
	const others = suggestion.size - 1;
	const numbersBottomToTop = [...suggestion.entries]
		.sort((left, right) => left.position - right.position)
		.map((entry) => entry.number);

	return (
		<>
			<OriginMovedDialog prompt={openPullRequest.originMoved} />
			<span aria-hidden="true">&middot;</span>
			<StackPopover
				ariaLabel={`Can be stacked with ${others} other pull ${others === 1 ? "request" : "requests"}`}
				baseRefName={suggestion.baseRefName}
				currentNumber={props.number}
				description="These pull requests chain but aren't stacked on GitHub yet."
				entries={suggestion.entries}
				footer={
					<CreateStackFooter
						error={createStack.error}
						isPending={createStack.isPending}
						onCreate={() =>
							createStack.create(
								{
									owner: props.owner,
									repo: props.repo,
									numbers: numbersBottomToTop,
								},
								() => setOpen(false),
							)
						}
					/>
				}
				onOpenChange={(next) => {
					if (!createStack.isPending) createStack.reset();
					setOpen(next);
				}}
				onOpenEntry={openEntry}
				open={open}
				title="Suggested stack"
				triggerContent={<LayersPlusIcon aria-hidden="true" />}
				triggerSize="icon-xs"
				triggerVariant="ghost"
			/>
		</>
	);
}
