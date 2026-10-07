"use client";

import { ORPCError } from "@orpc/client";
import { cn } from "cn";
import { ChevronDownIcon, Clock } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import { Group, GroupSeparator } from "#/components/ui/group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { toastManager } from "#/components/ui/toast";
import type {
	MergeMethod,
	MergePullRequestError,
	PullRequestMergeStatus,
	UnpushedCommitsCheck,
} from "#/features/pull-request/data/pr-data";
import {
	useMergePullRequest,
	usePullRequestMergeStatus,
	usePullRequestStack,
	useScheduledMerge,
	useScheduledMergeMutations,
	useUnpushedCommitsCheck,
} from "#/features/pull-request/data/pr-data";
import { useDismissOnInactive } from "#/features/pull-request/use-dismiss-on-inactive";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import {
	MergeErrorDialog,
	type MergeFailure,
	mergeFailureMessage,
} from "./merge-error-dialog";
import { deriveStackMerge } from "./pr-stack-merge";
import { UnpushedCommitsDialog } from "./unpushed-commits-dialog";

type PrMergeButtonProps = {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	/** This PR's tab is both the selected one and the window has focus — see `usePullRequestMergeStatus` (`pr-data.ts`). */
	watched: boolean;
	isSelectedTab: boolean;
};

const METHOD_LABEL: Record<MergeMethod, string> = {
	merge: "Merge pull request",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
};

const METHOD_STACK_LABEL: Record<MergeMethod, string> = {
	merge: "Merge stack",
	squash: "Squash and merge stack",
	rebase: "Rebase and merge stack",
};

const METHOD_MENU_LABEL: Record<MergeMethod, string> = {
	merge: "Merge",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
};

/** GitHub's own split-button descriptions, minus the commit count — `PullRequestMergeStatus` doesn't carry one, and this isn't worth a round trip to fetch just for the copy. */
const METHOD_DESCRIPTION: Record<MergeMethod, string> = {
	merge:
		"All commits from this branch will be added to the base branch via a merge commit.",
	squash:
		"The commits from this branch will be combined into one commit in the base branch.",
	rebase:
		"The commits from this branch will be rebased and added to the base branch.",
};

/** `pullRequests.mergeStatus`'s declared contract errors already carry a plain-English message from the sidecar — anything else (network down, sidecar crash) has no authored message to show. */
const mergeStatusErrorMessage = (error: unknown): string => {
	if (error instanceof ORPCError && typeof error.message === "string") {
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return "Couldn't check whether this pull request can be merged.";
};

/**
 * Resolves the button's label/disabled/tooltip from `status` in the exact
 * priority order the design settled on — each check short-circuits the
 * ones below it, so e.g. a draft PR that's also behind base still reads
 * "Draft", not "Update branch required". `method` is only read by the
 * final, enabled branch; every branch above it (including the
 * `status`/`method` nullness guard) ignores which method is selected.
 */
const resolveButtonState = (
	status: PullRequestMergeStatus | undefined,
	isLoading: boolean,
	isError: boolean,
	error: unknown,
	isMerging: boolean,
	method: MergeMethod | null,
	hasScheduledMerge: boolean,
): { label: string; disabled: boolean; title?: string } => {
	// Genuine initial loading (no data yet) wins over everything else, even
	// the terminal states below — there's nothing to read `state` off of.
	if (isLoading) {
		return { label: "Checking mergeability…", disabled: true };
	}
	// A hard error must resolve before the `status === undefined` guard below
	// — a query that has never once succeeded leaves `status` `undefined`
	// forever, and that guard would otherwise misread a failed, exhausted
	// query as merely "pending" and wedge the button on "Checking
	// mergeability…" permanently instead of surfacing the failure.
	if (isError) {
		return {
			label: "Merge unavailable",
			disabled: true,
			title: mergeStatusErrorMessage(error),
		};
	}
	// No data and no error is a pending-but-not-fetching query (e.g. paused
	// while offline — `usePullRequestMergeStatus` has no `enabled` guard) —
	// still "not confirmed mergeable yet", not a green light. `method` is
	// checked alongside `status` since it's derived from the same data (see
	// `PrMergeButton`) and being `null` here means the same thing: nothing
	// loaded yet to merge with.
	if (status === undefined || method === null) {
		return { label: "Checking mergeability…", disabled: true };
	}
	// Terminal states must resolve before the `mergeable === "UNKNOWN"` check
	// below — GitHub stops computing `mergeable` once a PR is merged or
	// closed, so it stays `"UNKNOWN"` forever and would otherwise wedge the
	// button on "Checking mergeability…" even after a successful merge.
	if (status.state === "MERGED") {
		return { label: "Merged", disabled: true };
	}
	if (status.state === "CLOSED") {
		return { label: "Closed", disabled: true };
	}
	if (status.mergeable === "UNKNOWN") {
		return { label: "Checking mergeability…", disabled: true };
	}
	if (isMerging) {
		return { label: "Merging…", disabled: true };
	}
	if (status.isDraft || status.mergeStateStatus === "DRAFT") {
		return { label: "Draft", disabled: true };
	}
	if (
		status.mergeable === "CONFLICTING" ||
		status.mergeStateStatus === "DIRTY"
	) {
		return { label: "Conflicts", disabled: true };
	}
	if (status.mergeStateStatus === "BLOCKED") {
		return !hasScheduledMerge
			? { label: "Merge blocked", disabled: true }
			: { label: "Merge pull request", disabled: false };
	}
	if (status.mergeStateStatus === "BEHIND") {
		return { label: "Update branch required", disabled: true };
	}
	return { label: METHOD_LABEL[method], disabled: false };
};

/**
 * The PR header's Merge button — disabled until `mergeStatus` confirms the
 * PR can actually be merged (see `resolveButtonState`), left-click merges
 * immediately with the currently selected method (deliberately no
 * confirmation dialog). A flush chevron opens a dropdown when there are
 * multiple methods or auto-merge can be scheduled.
 */
export function PrMergeButton({
	orpc,
	repoRoot,
	owner,
	repo,
	number,
	watched,
	isSelectedTab,
}: PrMergeButtonProps): React.ReactElement {
	const statusQuery = usePullRequestMergeStatus(
		orpc,
		{
			repoRoot,
			owner,
			repo,
			number,
		},
		isSelectedTab,
	);
	const stackQuery = usePullRequestStack(
		orpc,
		{ owner, repo, number },
		isSelectedTab,
	);
	const scheduledQuery = useScheduledMerge(
		orpc,
		{ repoRoot, owner, repo, number },
		isSelectedTab,
	);
	const [mergeFailure, setMergeFailure] = useState<MergeFailure | null>(null);
	const handleMergeError = useCallback(
		(error: MergePullRequestError, params: { number: number }) => {
			const message = mergeFailureMessage(error);
			const failure = {
				title: `Couldn't merge #${params.number}`,
				...message,
			};
			toastManager.add({
				title: failure.title,
				description: failure.reason,
				type: "error",
				actionProps: {
					children: "View details",
					onClick: () => setMergeFailure(failure),
				},
			});
		},
		[],
	);
	const {
		merge,
		mergeStack,
		isPending: isMerging,
	} = useMergePullRequest(orpc, handleMergeError);
	const { check: checkUnpushedCommits, isPending: isCheckingUnpushed } =
		useUnpushedCommitsCheck(orpc);
	const autoMerge = useScheduledMergeMutations(orpc, (error, params) => {
		const failure = {
			title: `Couldn't set auto-merge for #${params.number}`,
			...mergeFailureMessage(error),
		};
		toastManager.add({
			title: failure.title,
			description: failure.reason,
			type: "error",
			actionProps: {
				children: "View details",
				onClick: () => setMergeFailure(failure),
			},
		});
	});

	// Non-`"clean"` result of the click-time check below, parked here until
	// the user resolves the dialog it opens — `null` means either nothing's
	// been checked yet or the last check came back clean and merged straight
	// through.
	const [pendingUnpushedCheck, setPendingUnpushedCheck] = useState<{
		check: Exclude<UnpushedCommitsCheck, { status: "clean" }>;
		action: "merge" | "schedule";
	} | null>(null);

	// Holds only the user's own dropdown pick — falls back to the
	// scheduled method or server's `defaultMethod` until there is one, so a later
	// refetch (e.g. the one `useMergePullRequest` fires on success) never
	// overwrites a method the user already chose. `null` (no pick yet, no
	// status loaded yet) is a real state, not defaulted away — see
	// `resolveButtonState`'s explicit `method === null` guard and
	// `handleClick`'s bail-out below.
	const [selectedMethod, setSelectedMethod] = useState<MergeMethod | null>(
		null,
	);
	const [methodMenuOpen, setMethodMenuOpen] = useDismissOnInactive(watched);
	const method =
		selectedMethod ??
		scheduledQuery.data?.method ??
		statusQuery.data?.defaultMethod ??
		null;
	const stackMerge = deriveStackMerge(stackQuery.data, number);

	const { label, disabled, title } = resolveButtonState(
		statusQuery.data,
		statusQuery.isLoading,
		statusQuery.isError,
		statusQuery.error,
		isMerging,
		method,
		scheduledQuery.data !== undefined && scheduledQuery.data !== null,
	);

	const performMerge = useCallback(() => {
		if (method === null) return;
		const params = { repoRoot, owner, repo, number, method };
		if (stackMerge === null) {
			merge(params);
			return;
		}
		mergeStack(params);
	}, [merge, mergeStack, repoRoot, owner, repo, number, method, stackMerge]);

	// Fires a *fresh* `unpushedCommits` round trip on every click — the whole
	// point is catching commits made moments before clicking merge, so
	// `useUnpushedCommitsCheck` deliberately isn't a cached/polled query (see
	// its own doc). `"clean"` merges straight through with no extra friction;
	// anything else (real unpushed commits, or the check itself failing to
	// resolve one way or the other) parks in `pendingUnpushedCheck` and lets
	// `UnpushedCommitsDialog` ask the user rather than silently merging or
	// silently blocking.
	const performAction = (action: "merge" | "schedule") => {
		if (method === null) return;
		if (action === "schedule")
			autoMerge.schedule({
				repoRoot,
				owner,
				repo,
				number,
				method,
				route: stackMerge === null ? "merge" : "stack",
			});
		else performMerge();
	};
	const handleClick = async (action: "merge" | "schedule") => {
		if (
			(action === "merge" && disabled) ||
			method === null ||
			isCheckingUnpushed ||
			autoMerge.isPending
		)
			return;
		const result = await checkUnpushedCommits(repoRoot);
		if (result.status === "clean") {
			performAction(action);
			return;
		}
		setPendingUnpushedCheck({ check: result, action });
	};

	const allowedMethods = statusQuery.data?.allowedMethods ?? [];
	const showAutoMergeAction = scheduledQuery.data === null;
	// While the status is still loading the chevron is already in place (disabled,
	// see `methodMenuDisabled`) so it doesn't appear and push the header around.
	const showMethodPicker =
		(statusQuery.data === undefined && !statusQuery.isError) ||
		allowedMethods.length > 1 ||
		showAutoMergeAction ||
		(scheduledQuery.data !== undefined && scheduledQuery.data !== null);
	const methodMenuDisabled =
		statusQuery.data === undefined ||
		statusQuery.isError ||
		statusQuery.data.state !== "OPEN" ||
		isMerging ||
		isCheckingUnpushed ||
		autoMerge.isPending;
	const buttonLabel =
		!disabled && stackMerge !== null && stackMerge.count > 1 && method !== null
			? METHOD_STACK_LABEL[method]
			: label;

	return (
		<>
			<Group>
				<Button
					// Wide enough for "Checking mergeability…" and the longest method
					// label, so the label changing never resizes the button.
					className="min-w-44"
					disabled={disabled || isCheckingUnpushed || autoMerge.isPending}
					onClick={() => handleClick("merge")}
					size="sm"
					title={title}
					variant="outline"
				>
					{buttonLabel}
					{!disabled && stackMerge !== null && stackMerge.count > 1 && (
						<span className="rounded-full bg-muted px-1.5 py-0.5 font-mono text-[10px] tabular-nums">
							{stackMerge.count}
						</span>
					)}
				</Button>
				{showMethodPicker && (
					<>
						<GroupSeparator />
						<DropdownMenu
							onOpenChange={setMethodMenuOpen}
							open={methodMenuOpen}
						>
							<DropdownMenuTrigger
								aria-label="Select merge method"
								className={cn(
									buttonVariants({ size: "sm", variant: "outline" }),
									"w-6 px-0",
								)}
								disabled={methodMenuDisabled}
							>
								<ChevronDownIcon />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="w-80">
								<DropdownMenuRadioGroup
									onValueChange={(value) =>
										setSelectedMethod(value as MergeMethod)
									}
									value={method ?? undefined}
								>
									<DropdownMenuLabel>Select method</DropdownMenuLabel>
									{allowedMethods.map((candidate) => (
										<DropdownMenuRadioItem
											closeOnClick
											key={candidate}
											value={candidate}
										>
											<div className="flex flex-col gap-0.5 py-0.5">
												<span className="font-medium">
													{METHOD_MENU_LABEL[candidate]}
												</span>
												<span className="text-muted-foreground text-xs">
													{METHOD_DESCRIPTION[candidate]}
												</span>
											</div>
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
								{showAutoMergeAction && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuGroup>
											<DropdownMenuLabel>Actions</DropdownMenuLabel>
											<DropdownMenuItem
												disabled={autoMerge.isPending || method === null}
												onClick={() => handleClick("schedule")}
											>
												<Clock />
												Set auto-merge when checks pass
											</DropdownMenuItem>
										</DropdownMenuGroup>
									</>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				)}
			</Group>
			<UnpushedCommitsDialog
				check={pendingUnpushedCheck?.check ?? null}
				onMergeAnyway={() => {
					if (pendingUnpushedCheck === null) return;
					setPendingUnpushedCheck(null);
					performAction(pendingUnpushedCheck.action);
				}}
				onOpenChange={(open) => {
					if (!open) setPendingUnpushedCheck(null);
				}}
			/>
			<MergeErrorDialog
				failure={mergeFailure}
				onOpenChange={(open) => {
					if (!open) setMergeFailure(null);
				}}
			/>
		</>
	);
}
