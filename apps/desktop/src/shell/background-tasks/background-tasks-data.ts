import type { SidecarClient } from "@repo/sidecar-api";
import {
	useMutation,
	useMutationState,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { toastManager } from "#/components/ui/toast";
import type {
	MergeMethod,
	MergePullRequestParams,
	Session,
} from "#/features/pull-request/data/pr-data";
import { mergeFailureMessage } from "#/features/pull-request/merge/merge-error-dialog";
import type { SidecarQueryUtils } from "#/infra/backend-context";

type PullRequestRef = {
	owner: string;
	repo: string;
	number: number;
};

/** `title` is absent when the review store has never seen a session for the PR. */
type TaskCommon = PullRequestRef & {
	title?: string;
	method: MergeMethod;
	route: "merge" | "stack";
};

export type ScheduledMergeTask = TaskCommon & {
	kind: "scheduled-merge";
	repoRoot: string;
};

/** An immediate merge still in flight; GitHub's merge is atomic, so unlike a scheduled one it cannot be stopped. */
export type MergingTask = TaskCommon & { kind: "merging" };

export type BackgroundTask = ScheduledMergeTask | MergingTask;

export type ScheduledMergeEntry = Awaited<
	ReturnType<SidecarClient["pullRequests"]["scheduledMerges"]>
>[number];

type PendingMerge = {
	params: MergePullRequestParams;
	route: "merge" | "stack";
};

/** GitHub ignores case in `owner/repo`. */
function pullRequestIdentity(ref: PullRequestRef): string {
	return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

export function backgroundTaskKey(
	task: Pick<BackgroundTask, "kind"> & PullRequestRef,
): string {
	return `${task.kind}:${pullRequestIdentity(task)}`;
}

/**
 * Only PRs without an open tab count as background work: a task leaves the
 * tracker the moment its tab is reopened, since the tab's own merge button and
 * auto-merge indicator take over.
 */
export function buildBackgroundTasks(input: {
	scheduled: readonly ScheduledMergeEntry[];
	pendingMerges: readonly PendingMerge[];
	openPullRequests: readonly PullRequestRef[];
}): BackgroundTask[] {
	const open = new Set(input.openPullRequests.map(pullRequestIdentity));
	const scheduled = input.scheduled
		.filter((entry) => !open.has(pullRequestIdentity(entry)))
		.sort((a, b) => a.createdAt - b.createdAt)
		.map(
			(entry): ScheduledMergeTask => ({
				kind: "scheduled-merge",
				owner: entry.owner,
				repo: entry.repo,
				number: entry.number,
				method: entry.method,
				route: entry.route,
				repoRoot: entry.repoRoot,
				...(entry.title === undefined ? {} : { title: entry.title }),
			}),
		);
	const merging = input.pendingMerges
		.filter((pending) => !open.has(pullRequestIdentity(pending.params)))
		.map(
			(pending): MergingTask => ({
				kind: "merging",
				owner: pending.params.owner,
				repo: pending.params.repo,
				number: pending.params.number,
				method: pending.params.method,
				route: pending.route,
			}),
		);
	return [...scheduled, ...merging];
}

export function useBackgroundTasks(
	orpc: SidecarQueryUtils,
	sessions: readonly Session[],
): {
	tasks: readonly BackgroundTask[];
	stop: (task: ScheduledMergeTask) => void;
	stoppingKeys: ReadonlySet<string>;
} {
	const queryClient = useQueryClient();
	const scheduledQuery = useQuery(
		orpc.pullRequests.scheduledMerges.queryOptions(),
	);
	const pendingMerge = useMutationState({
		filters: {
			mutationKey: orpc.pullRequests.merge.mutationKey(),
			status: "pending",
		},
		select: (mutation): PendingMerge => ({
			params: mutation.state.variables as MergePullRequestParams,
			route: "merge",
		}),
	});
	const pendingStackMerge = useMutationState({
		filters: {
			mutationKey: orpc.pullRequests.mergeStack.mutationKey(),
			status: "pending",
		},
		select: (mutation): PendingMerge => ({
			params: mutation.state.variables as MergePullRequestParams,
			route: "stack",
		}),
	});
	const pendingStop = useMutationState({
		filters: {
			mutationKey: orpc.pullRequests.cancelScheduledMerge.mutationKey(),
			status: "pending",
		},
		select: (mutation) =>
			mutation.state.variables as Parameters<
				SidecarClient["pullRequests"]["cancelScheduledMerge"]
			>[0],
	});

	const stopMutation = useMutation({
		...orpc.pullRequests.cancelScheduledMerge.mutationOptions(),
		onSuccess: (_data, variables) =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.pullRequests.scheduledMerges.key(),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.pullRequests.scheduledMerge.key({
						input: {
							owner: variables.owner,
							repo: variables.repo,
							number: variables.number,
						},
					}),
				}),
			]),
		onError: (error, variables) => {
			toastManager.add({
				title: `Couldn't stop auto-merge for ${variables.owner}/${variables.repo}#${variables.number}`,
				description: mergeFailureMessage(error).reason,
				type: "error",
			});
		},
	});

	const tasks = useMemo(
		() =>
			buildBackgroundTasks({
				// Passive chrome: until the list loads (or if it fails) there is
				// simply nothing to show, and the query's retries are the recovery.
				scheduled: scheduledQuery.isSuccess ? scheduledQuery.data : [],
				pendingMerges: [...pendingMerge, ...pendingStackMerge],
				openPullRequests: sessions.flatMap((session) =>
					session.target.kind === "pr" ? [session.target] : [],
				),
			}),
		[
			scheduledQuery.isSuccess,
			scheduledQuery.data,
			pendingMerge,
			pendingStackMerge,
			sessions,
		],
	);
	const stoppingKeys = useMemo(
		() =>
			new Set(
				pendingStop.map((variables) =>
					backgroundTaskKey({ kind: "scheduled-merge", ...variables }),
				),
			),
		[pendingStop],
	);

	return {
		tasks,
		stop: (task) =>
			stopMutation.mutate({
				repoRoot: task.repoRoot,
				owner: task.owner,
				repo: task.repo,
				number: task.number,
			}),
		stoppingKeys,
	};
}
