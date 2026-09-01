"use client";

import { ORPCError } from "@orpc/client";
import { ChevronDownIcon } from "lucide-react";
import { useCallback, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import { Group, GroupSeparator } from "#/components/ui/group";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type {
	MergeMethod,
	PullRequestMergeStatus,
	UnpushedCommitsCheck,
} from "#/lib/pr-data";
import {
	useMergePullRequest,
	usePullRequestMergeStatus,
	useUnpushedCommitsCheck,
} from "#/lib/pr-data";
import { cn } from "#/lib/utils";
import { UnpushedCommitsDialog } from "./unpushed-commits-dialog";

type PrMergeButtonProps = {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	/** This PR's tab is both the selected one and the window has focus — see `usePullRequestMergeStatus` (`pr-data.ts`). */
	watched: boolean;
};

const METHOD_LABEL: Record<MergeMethod, string> = {
	merge: "Merge pull request",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
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
		return { label: "Merge blocked", disabled: true };
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
 * confirmation dialog). When the repo allows more than one merge method, a
 * flush chevron opens a dropdown to switch among them — a single allowed
 * method renders the plain button with no chevron at all.
 */
export function PrMergeButton({
	orpc,
	repoRoot,
	owner,
	repo,
	number,
	watched,
}: PrMergeButtonProps): React.ReactElement {
	const statusQuery = usePullRequestMergeStatus(
		orpc,
		{ repoRoot, owner, repo, number },
		watched,
	);
	const { merge, isPending: isMerging } = useMergePullRequest(orpc);
	const { check: checkUnpushedCommits, isPending: isCheckingUnpushed } =
		useUnpushedCommitsCheck(orpc);

	// Non-`"clean"` result of the click-time check below, parked here until
	// the user resolves the dialog it opens — `null` means either nothing's
	// been checked yet or the last check came back clean and merged straight
	// through.
	const [pendingUnpushedCheck, setPendingUnpushedCheck] = useState<Exclude<
		UnpushedCommitsCheck,
		{ status: "clean" }
	> | null>(null);

	// Holds only the user's own dropdown pick — falls back to the
	// server's `defaultMethod` on every render until there is one, so a later
	// refetch (e.g. the one `useMergePullRequest` fires on success) never
	// overwrites a method the user already chose. `null` (no pick yet, no
	// status loaded yet) is a real state, not defaulted away — see
	// `resolveButtonState`'s explicit `method === null` guard and
	// `handleClick`'s bail-out below.
	const [selectedMethod, setSelectedMethod] = useState<MergeMethod | null>(
		null,
	);
	const method = selectedMethod ?? statusQuery.data?.defaultMethod ?? null;

	const { label, disabled, title } = resolveButtonState(
		statusQuery.data,
		statusQuery.isLoading,
		statusQuery.isError,
		statusQuery.error,
		isMerging,
		method,
	);

	const performMerge = useCallback(() => {
		if (method === null) return;
		merge({ repoRoot, owner, repo, number, method });
	}, [merge, repoRoot, owner, repo, number, method]);

	// Fires a *fresh* `unpushedCommits` round trip on every click — the whole
	// point is catching commits made moments before clicking merge, so
	// `useUnpushedCommitsCheck` deliberately isn't a cached/polled query (see
	// its own doc). `"clean"` merges straight through with no extra friction;
	// anything else (real unpushed commits, or the check itself failing to
	// resolve one way or the other) parks in `pendingUnpushedCheck` and lets
	// `UnpushedCommitsDialog` ask the user rather than silently merging or
	// silently blocking.
	const handleClick = useCallback(async () => {
		if (disabled || method === null || isCheckingUnpushed) return;
		const result = await checkUnpushedCommits(repoRoot);
		if (result.status === "clean") {
			performMerge();
			return;
		}
		setPendingUnpushedCheck(result);
	}, [
		disabled,
		method,
		isCheckingUnpushed,
		checkUnpushedCommits,
		repoRoot,
		performMerge,
	]);

	const allowedMethods = statusQuery.data?.allowedMethods ?? [];
	const showMethodPicker = allowedMethods.length > 1;

	return (
		<>
			<Group>
				<Button
					disabled={disabled || isCheckingUnpushed}
					onClick={handleClick}
					size="sm"
					title={title}
					variant="outline"
				>
					{label}
				</Button>
				{showMethodPicker && (
					<>
						<GroupSeparator />
						<DropdownMenu>
							<DropdownMenuTrigger
								aria-label="Select merge method"
								className={cn(
									buttonVariants({ size: "sm", variant: "outline" }),
									"w-6 px-0",
								)}
								disabled={disabled || isCheckingUnpushed}
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
							</DropdownMenuContent>
						</DropdownMenu>
					</>
				)}
			</Group>
			<UnpushedCommitsDialog
				check={pendingUnpushedCheck}
				onMergeAnyway={() => {
					setPendingUnpushedCheck(null);
					performMerge();
				}}
				onOpenChange={(open) => {
					if (!open) setPendingUnpushedCheck(null);
				}}
			/>
		</>
	);
}
