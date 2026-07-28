/**
 * The Phase 1 data seam, now backed by the live sidecar contract
 * (`packages/sidecar-api`) through `backend-context.tsx`'s oRPC + TanStack
 * Query utils. Every hook here takes the `SidecarQueryUtils` instance
 * (`useBackendContext()`'s `orpc`, only available once the backend is
 * `"ready"`) explicitly rather than reaching for context itself, so callers
 * can't accidentally invoke them before a sidecar connection exists.
 *
 * Phase 2 made `FileChange.review`/`FileContent.review` real (see
 * `packages/sidecar-api/src/diff.ts`), closing the read-path gap Phase 1 left
 * open — `useReviewState` below derives the sidebar/pane's `ReviewState` map
 * straight from `FileChange.review` instead of tracking ticks client-side.
 */
import {
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
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

/** Mirrors `FileReview` (`packages/sidecar-api/src/diff.ts`) — `null` until a file is ticked Reviewed. */
export type FileReview = {
	viewed: boolean;
	reviewedHash: string | null;
	changedSinceReview: boolean;
};

export type FileChange = {
	path: string;
	oldPath?: string;
	status: FileStatus;
	category: FileCategory;
	additions: number;
	deletions: number;
	fingerprint: string;
	binary: boolean;
	review: FileReview | null;
};

/**
 * One contiguous run of a file's `base → head` diff — mirrors `ReviewRange`
 * (`packages/sidecar-api/src/diff.ts`). 1-based inclusive, in head-file line
 * numbers, the same coordinate space the diff renderer's per-line hooks use.
 */
export type ReviewRange = {
	startLine: number;
	endLine: number;
	status: "reviewed" | "new";
};

/** Mirrors `FileContentReview` — present only once the file's been ticked Reviewed. */
export type FileContentReview = {
	changedSinceReview: boolean;
	ranges: readonly ReviewRange[];
};

export type FileContent = {
	patch: string;
	oldContent?: string;
	newContent?: string;
	truncated: boolean;
	review: FileContentReview | null;
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
 * Derives the sidebar/pane's three-value `ReviewState` map straight from
 * `FileChange.review` — a file with no row is `"unreviewed"`, one whose
 * snapshot still matches head is `"viewed"` (mutes the row), and one that's
 * moved since is `"changed-after-review"` (the orange dot). No client-side
 * tracking: a reload sees exactly what the sidecar persisted.
 */
export function useReviewState(
	files: readonly FileChange[],
): ReadonlyMap<string, ReviewState> {
	return useMemo(() => {
		const map = new Map<string, ReviewState>();
		for (const file of files) {
			if (file.review === null) continue;
			map.set(
				file.path,
				file.review.changedSinceReview ? "changed-after-review" : "viewed",
			);
		}
		return map;
	}, [files]);
}

/**
 * `review.setViewed`, refetching the two queries its snapshot write
 * invalidates on success: `diff.files` (the sidebar's mute + orange dot) and
 * this file's `diff.file` (the pane's collapse ranges). No optimistic flip —
 * `changedSinceReview` and the reconciliation ranges are server-computed from
 * the snapshot this write just took, so there's nothing honest to predict
 * client-side before the round trip resolves.
 */
export function useSetFileViewed(
	orpc: SidecarQueryUtils,
	sessionId: string,
): (path: string, viewed: boolean) => void {
	const queryClient = useQueryClient();
	const mutation = useMutation(orpc.review.setViewed.mutationOptions());

	return useCallback(
		(path: string, viewed: boolean) => {
			mutation.mutate(
				{ sessionId, path, viewed },
				{
					onSuccess: () => {
						queryClient.invalidateQueries({
							queryKey: orpc.diff.files.key({ input: { sessionId } }),
						});
						queryClient.invalidateQueries({
							queryKey: orpc.diff.file.key({ input: { sessionId, path } }),
						});
					},
				},
			);
		},
		[mutation, queryClient, orpc, sessionId],
	);
}
