/**
 * The Phase 1 data seam, now backed by the live sidecar contract
 * (`packages/sidecar-api`) through `backend-context.tsx`'s oRPC + TanStack
 * Query utils. Every hook here takes the `SidecarQueryUtils` instance
 * (`useBackendContext()`'s `orpc`, only available once the backend is
 * `"ready"`) explicitly rather than reaching for context itself, so callers
 * can't accidentally invoke them before a sidecar connection exists.
 *
 * `ReviewState` stays a three-value type for Phase 2 forward-compatibility
 * (the sidebar/pane already render `"changed-after-review"`'s orange dot),
 * but `useReviewedFiles` below can only ever produce `"unreviewed"` /
 * `"viewed"` — see its doc comment for why, and `AGENTS.md` for the
 * contract-gap note this stands in for.
 */
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";

export type PullRequestInfo = {
	number: number;
	title: string;
	baseRef: string;
	headRef: string;
	owner: string;
	repo: string;
};

export type Session = {
	id: string;
	repoRoot: string;
	pr: PullRequestInfo | null;
};

export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type FileCategory = "implementation" | "test" | "generated";

export type FileChange = {
	path: string;
	oldPath?: string;
	status: FileStatus;
	category: FileCategory;
	additions: number;
	deletions: number;
	fingerprint: string;
	binary: boolean;
};

export type FileContent = {
	patch: string;
	oldContent?: string;
	newContent?: string;
	truncated: boolean;
};

export type ReviewState = "unreviewed" | "viewed" | "changed-after-review";

/** Mirrors `sessions.list()` plus a `sessions.close` mutation, kept live by `events.subscribe`. */
export function useSessions(orpc: SidecarQueryUtils): {
	sessions: readonly Session[];
	isLoading: boolean;
	closeSession: (sessionId: string) => void;
} {
	const queryClient = useQueryClient();
	const sessionsQuery = useQuery(orpc.sessions.list.queryOptions());
	const closeMutation = useMutation(orpc.sessions.close.mutationOptions());

	// The CLI opening (or an idle tab closing) a session out from under a
	// running app is exactly what `events.subscribe` exists for — a live
	// query resolves to the latest emitted `SessionEvent`, so any event just
	// invalidates the list rather than trying to reconcile it by hand.
	const eventsQuery = useQuery(orpc.events.subscribe.liveOptions());
	useEffect(() => {
		if (eventsQuery.data === undefined) return;
		queryClient.invalidateQueries({ queryKey: orpc.sessions.list.queryKey() });
	}, [eventsQuery.data, queryClient, orpc]);

	const closeSession = useCallback(
		(sessionId: string) => {
			closeMutation.mutate(
				{ sessionId },
				{
					onSuccess: () => {
						queryClient.invalidateQueries({
							queryKey: orpc.sessions.list.queryKey(),
						});
					},
				},
			);
		},
		[closeMutation, queryClient, orpc],
	);

	return {
		sessions: sessionsQuery.data ?? [],
		isLoading: sessionsQuery.isLoading,
		closeSession,
	};
}

/** Mirrors `diff.files({ sessionId })` — metadata for every file in the PR. */
export function useFileChanges(
	orpc: SidecarQueryUtils,
	sessionId: string,
): { files: readonly FileChange[]; isLoading: boolean; error: unknown } {
	const query = useQuery(
		orpc.diff.files.queryOptions({ input: { sessionId } }),
	);
	return {
		files: query.data ?? [],
		isLoading: query.isLoading,
		error: query.error,
	};
}

/** Mirrors `diff.file({ sessionId, path, force })`, lazy per file. */
export function useFileContents(
	orpc: SidecarQueryUtils,
	sessionId: string,
	paths: readonly string[],
	forcedPaths: ReadonlySet<string>,
): ReadonlyMap<
	string,
	{ content: FileContent | undefined; isLoading: boolean; isError: boolean }
> {
	const results = useQueries({
		queries: paths.map((path) =>
			orpc.diff.file.queryOptions({
				input: forcedPaths.has(path)
					? { sessionId, path, force: true }
					: { sessionId, path },
			}),
		),
	});

	return useMemo(() => {
		const map = new Map<
			string,
			{ content: FileContent | undefined; isLoading: boolean; isError: boolean }
		>();
		paths.forEach((path, index) => {
			const result = results[index];
			map.set(path, {
				content: result?.data,
				isLoading: result?.isLoading ?? false,
				isError: result?.isError ?? false,
			});
		});
		return map;
	}, [paths, results]);
}

/**
 * Per-file Reviewed state, backed by the real `review.setViewed` write path.
 *
 * **Contract gap**: the wire contract has no read counterpart —
 * `review.setViewed` is write-only, and neither `diff.files` nor any
 * `review.*` query returns which files are already viewed for a session
 * (`ReviewStore.getFileReviewState` exists in `@repo/review` but isn't
 * exposed through `packages/sidecar-api/src/review.ts`). So this hook can
 * only track viewed state for the lifetime of this component tree —
 * ticks are optimistic and call the real mutation (so Phase 2's snapshot
 * write path is exercised correctly), but a reload has no way to rehydrate
 * which files were already reviewed. Reported instead of worked around
 * silently, per this task's instructions — see the final report.
 */
export function useReviewedFiles(
	orpc: SidecarQueryUtils,
	sessionId: string,
): {
	reviewState: ReadonlyMap<string, ReviewState>;
	setViewed: (path: string, viewed: boolean) => void;
} {
	const [viewedPaths, setViewedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const mutation = useMutation(orpc.review.setViewed.mutationOptions());

	const setViewed = useCallback(
		(path: string, viewed: boolean) => {
			setViewedPaths((current) => {
				const next = new Set(current);
				if (viewed) next.add(path);
				else next.delete(path);
				return next;
			});
			mutation.mutate(
				{ sessionId, path, viewed },
				{
					onError: () => {
						// Roll back the optimistic flip on a failed write.
						setViewedPaths((current) => {
							const next = new Set(current);
							if (viewed) next.delete(path);
							else next.add(path);
							return next;
						});
					},
				},
			);
		},
		[mutation, sessionId],
	);

	const reviewState = useMemo(() => {
		const map = new Map<string, ReviewState>();
		for (const path of viewedPaths) map.set(path, "viewed");
		return map;
	}, [viewedPaths]);

	return { reviewState, setViewed };
}
