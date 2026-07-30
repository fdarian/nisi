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
 * straight from `FileChange.review`, overlaid with any `review.setViewed`
 * call still in flight so the checkbox doesn't wait on a round trip for the
 * one field (the boolean) that's honest to predict — see that hook's doc
 * comment for the split.
 */
import type { Query } from "@tanstack/react-query";
import {
	useMutation,
	useMutationState,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useIncludeUncommitted } from "#/lib/settings-data";

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
 * What currently vouches for a reviewed range — mirrors `ReviewSource`
 * (`packages/sidecar-api/src/diff.ts`). `{kind: "file"}` is the whole-file
 * Reviewed checkbox; `{kind: "range", blockId, blockLabel}` is a walkthrough
 * reference block's claim on this specific location.
 */
export type ReviewSource =
	| { kind: "file" }
	| { kind: "range"; blockId: string; blockLabel: string };

/**
 * One contiguous run of a file's `base → head` diff — mirrors `ReviewRange`
 * (`packages/sidecar-api/src/diff.ts`). 1-based inclusive, in head-file line
 * numbers, the same coordinate space the diff renderer's per-line hooks use.
 * `reviewedVia` is `null` iff `status` is `"new"`.
 */
export type ReviewRange = {
	startLine: number;
	endLine: number;
	status: "reviewed" | "new";
	reviewedVia: ReviewSource | null;
};

/** Mirrors `FileContentReview` — present whenever the file has any active review claim, whole-file or block-scoped. */
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

/**
 * Mirrors `diff.files({ sessionId, includeUncommitted })` — metadata for
 * every file in the PR. `includeUncommitted` is sourced from the persisted
 * setting rather than taken as a param, and folded straight into the query
 * `input` — since oRPC's TanStack Query integration derives the actual cache
 * key from the full `input` object, flipping the toggle produces a distinct
 * key (and thus a real refetch) instead of leaving the other mode's cached
 * result on screen.
 */
export function useFileChanges(
	orpc: SidecarQueryUtils,
	sessionId: string,
): { files: readonly FileChange[]; isLoading: boolean; error: unknown } {
	const [includeUncommitted] = useIncludeUncommitted(orpc);
	const query = useQuery(
		orpc.diff.files.queryOptions({
			input: { sessionId, includeUncommitted },
		}),
	);
	return {
		files: query.data ?? [],
		isLoading: query.isLoading,
		error: query.error,
	};
}

/**
 * How many paths ride in one `diff.fileContents` request. Fork/exec, not
 * git's own work, dominates the sidecar's cost per request (see
 * `@repo/git`'s `getFileContents` doc comment), so collapsing a whole PR's
 * open files into one request is what actually pays off — but `paths` here
 * can be *every* non-binary file in the PR (`DiffPane` passes it every
 * visible `FileChange`, not just what's scrolled into view; `@pierre/diffs`
 * virtualizes rendering, not fetching), and one request is all-or-nothing:
 * the pane would wait on the slowest file in the whole PR before rendering
 * any of them. Chunking splits the difference — a typical PR (well under
 * this size) still collapses to a single request, while a large one streams
 * in a handful of waves instead of blocking on one giant round trip.
 */
const FILE_CONTENTS_CHUNK_SIZE = 30;

const chunkPaths = (
	paths: readonly string[],
	size: number,
): readonly (readonly string[])[] => {
	const chunks: Array<readonly string[]> = [];
	for (let index = 0; index < paths.length; index += size) {
		chunks.push(paths.slice(index, index + size));
	}
	return chunks;
};

/**
 * Mirrors `diff.fileContents({ sessionId, paths, includeUncommitted })`,
 * batched — `paths` is chunked (`FILE_CONTENTS_CHUNK_SIZE`) into one
 * `useQueries` entry per chunk rather than one per path, so opening N files
 * costs a small constant number of sidecar round trips instead of N
 * independent ones. `includeUncommitted` is sourced from the persisted
 * setting and folded into every chunk's `input` — same cache-key reasoning
 * as `useFileChanges`. Callers still get the same per-path map back; the
 * chunking is an internal batching detail; a path absent from its chunk's
 * response (not actually part of the diff, or a request still loading with
 * no cached data) reports `content: undefined` with `isError`/`isLoading`
 * reflecting its chunk's own status.
 */
export function useFileContents(
	orpc: SidecarQueryUtils,
	sessionId: string,
	paths: readonly string[],
	forcedPaths: ReadonlySet<string>,
): ReadonlyMap<
	string,
	{ content: FileContent | undefined; isLoading: boolean; isError: boolean }
> {
	const [includeUncommitted] = useIncludeUncommitted(orpc);
	const chunks = useMemo(
		() => chunkPaths(paths, FILE_CONTENTS_CHUNK_SIZE),
		[paths],
	);

	const results = useQueries({
		queries: chunks.map((chunk) =>
			orpc.diff.fileContents.queryOptions({
				input: {
					sessionId,
					paths: chunk.map((path) =>
						forcedPaths.has(path) ? { path, force: true } : { path },
					),
					includeUncommitted,
				},
			}),
		),
	});

	return useMemo(() => {
		const map = new Map<
			string,
			{ content: FileContent | undefined; isLoading: boolean; isError: boolean }
		>();
		chunks.forEach((chunk, chunkIndex) => {
			const result = results[chunkIndex];
			const contentByPath = new Map(
				(result?.data ?? []).map(
					(entry) => [entry.path, entry.content] as const,
				),
			);
			for (const path of chunk) {
				const content = contentByPath.get(path);
				// A path the sidecar reported as not part of the diff (`content:
				// null`) is a fetch-level error the same way a 404 used to be —
				// distinct from "this chunk hasn't resolved yet" (`undefined`).
				const pathNotInDiff = result?.isSuccess === true && content === null;
				map.set(path, {
					content: content ?? undefined,
					isLoading: result?.isLoading ?? false,
					isError: (result?.isError ?? false) || pathNotInDiff,
				});
			}
		});
		return map;
	}, [chunks, results]);
}

/** Narrows `value` to a plain object so a property read off it is type-safe rather than an `unknown`-on-`unknown` cast. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

/**
 * `invalidateQueries`' `predicate`, meant to be combined with a `queryKey`
 * filter that already narrows to one session's `diff.fileContents` queries
 * (see `useSetFileViewed`/`useSetRangeViewed` below) — true when that
 * query's own recorded request actually covered `path`, so a single file's
 * review-state change refetches only the one chunk it landed in instead of
 * every chunk for the session.
 *
 * Reads the request TanStack Query already cached for that query (the last
 * element of `query.queryKey` is the `{ input }` oRPC embeds — see
 * `generateOperationKey` in `@orpc/tanstack-query`) rather than
 * recomputing `useFileContents`' chunk boundaries here from a fresh
 * `paths`/`forcedPaths` pair: this function's only callers are a mutation's
 * `onSuccess`, which has no way to know the exact per-path `force` flag a
 * given chunk was actually fetched with, so reconstructing that chunk's
 * request and matching it key-for-key would silently fail to invalidate
 * whenever it guessed a `force` flag wrong. Asking the cache what it
 * actually fetched sidesteps that.
 *
 * Fails open, not closed. `@orpc/tanstack-query` is a pinned beta — if a
 * future bump ever changes `query.queryKey`'s layout, every `isRecord`/
 * `Array.isArray` check below fails and this returns `true` rather than
 * `false`. `true` over-invalidates (degrades back to the session-wide
 * refetch this function exists to narrow past — merely slower); `false`
 * would under-invalidate and leave stale reconciliation ranges on screen
 * with nothing to signal it. Only a positively parsed `paths` array that
 * provably excludes `path` is allowed to return `false` — don't collapse
 * this back into an `as`-cast-plus-`?? false` chain.
 */
const queryCoveredPath = (query: Query, path: string): boolean => {
	const queryKey = query.queryKey;
	const meta = queryKey[queryKey.length - 1];
	if (!isRecord(meta)) return true;

	const input = meta.input;
	if (!isRecord(input)) return true;

	const paths = input.paths;
	if (!Array.isArray(paths)) return true;

	return paths.some((request) => isRecord(request) && request.path === path);
};

/** The part of a pending `review.setViewed` call we're willing to predict — see `useReviewState`. */
type PendingFileViewed = { path: string; viewed: boolean };

/**
 * Derives the sidebar/pane's three-value `ReviewState` map from
 * `FileChange.review`, overlaid with any `review.setViewed` calls still in
 * flight — a file with no row and no pending call is `"unreviewed"`, one
 * whose snapshot still matches head (or whose pending call just requested
 * `viewed: true`) is `"viewed"` (mutes the row), and one that's moved since
 * is `"changed-after-review"` (the orange dot). That last distinction stays
 * server-only: a pending call only ever predicts `"viewed"`/`"unreviewed"`,
 * never `"changed-after-review"`, since `changedSinceReview` comes from a
 * snapshot hash we don't have until the server responds (see the doc comment
 * on `useSetFileViewed` for why nothing beyond the boolean is honest to
 * predict). The overlay is read via `useMutationState`'s `status: "pending"`
 * filter, so it self-clears the instant a call settles either way — success
 * lands through the invalidation below, failure just reverts to whatever
 * `diff.files` already said, with no stuck checkbox — and it can't be
 * clobbered by a `diff.files` refetch that resolves mid-flight, since it
 * doesn't read that query's data at all.
 */
export function useReviewState(
	orpc: SidecarQueryUtils,
	files: readonly FileChange[],
): ReadonlyMap<string, ReviewState> {
	const pendingMutationKey = useMemo(
		() => orpc.review.setViewed.mutationKey(),
		[orpc],
	);
	const pendingViewedCalls = useMutationState({
		filters: { mutationKey: pendingMutationKey, status: "pending" },
		select: (mutation) => mutation.state.variables as PendingFileViewed,
	});

	return useMemo(() => {
		const pendingByPath = new Map<string, boolean>();
		for (const call of pendingViewedCalls) {
			pendingByPath.set(call.path, call.viewed);
		}

		const map = new Map<string, ReviewState>();
		for (const file of files) {
			const pendingViewed = pendingByPath.get(file.path);
			if (pendingViewed !== undefined) {
				map.set(file.path, pendingViewed ? "viewed" : "unreviewed");
				continue;
			}
			if (file.review === null) continue;
			map.set(
				file.path,
				file.review.changedSinceReview ? "changed-after-review" : "viewed",
			);
		}
		return map;
	}, [files, pendingViewedCalls]);
}

/**
 * `review.setViewed`, refetching the two queries its snapshot write
 * invalidates on success: `diff.files` (the sidebar's mute + orange dot) and
 * this file's `diff.fileContents` chunk (the pane's collapse ranges).
 * `diff.fileContents` is batched (`useFileContents`), so there's no
 * single-path cache entry to target directly — `queryCoveredPath` narrows
 * the session-wide `diff.fileContents` match down to just the one chunk
 * that actually requested `path`, so ticking one file's checkbox costs one
 * chunk's refetch regardless of how many files/chunks the PR has, not the
 * whole session's worth (contrast `useLiveFileChanges` below, which
 * deliberately *does* refetch every chunk — a real worktree change could
 * touch any file, not just one). No optimistic cache write here —
 * `changedSinceReview` and the reconciliation ranges are server-computed
 * from the snapshot this write just took, so there's nothing honest to
 * predict client-side before the round trip resolves. The boolean itself is
 * the exception: `useReviewState` overlays this mutation's in-flight
 * `variables` (via `useMutationState`, matched by the stable `mutationKey`
 * `mutationOptions()` derives from this procedure's path) so the checkbox
 * flips the instant it's clicked instead of waiting on this round trip —
 * see that hook's doc comment.
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
							queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
							predicate: (query) => queryCoveredPath(query, path),
						});
					},
				},
			);
		},
		[mutation, queryClient, orpc, sessionId],
	);
}

export type SetRangeViewedParams = {
	path: string;
	blockId: string;
	blockLabel: string;
	ranges: readonly { startLine: number; endLine: number }[];
	viewed: boolean;
};

/**
 * `review.setRangeViewed` — one walkthrough reference block's claim on a set
 * of ranges within one file. Same invalidation shape as `useSetFileViewed`,
 * narrowed to `params.path`'s own `diff.fileContents` chunk via
 * `queryCoveredPath`: the reference pane's own query and the Files Changed
 * diff pane's are the same batched cache entries (both key off `sessionId`
 * and land in the same chunk for a given path), so invalidating just that
 * chunk here is what keeps a tick in one view visible in the other without
 * a manual reload — and without refetching every other open file's chunk.
 */
export function useSetRangeViewed(
	orpc: SidecarQueryUtils,
	sessionId: string,
): (params: SetRangeViewedParams) => void {
	const queryClient = useQueryClient();
	const mutation = useMutation(orpc.review.setRangeViewed.mutationOptions());

	return useCallback(
		(params: SetRangeViewedParams) => {
			mutation.mutate(
				{ sessionId, ...params },
				{
					onSuccess: () => {
						queryClient.invalidateQueries({
							queryKey: orpc.diff.files.key({ input: { sessionId } }),
						});
						queryClient.invalidateQueries({
							queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
							predicate: (query) => queryCoveredPath(query, params.path),
						});
					},
				},
			);
		},
		[mutation, queryClient, orpc, sessionId],
	);
}

/**
 * Keeps `diff.files`/`diff.fileContents` live: on the sidecar's
 * `session-files-changed` event (the 2s worktree poller noticing a change —
 * see `packages/sidecar-api/src/events.ts`) for *this* session, invalidates
 * both queries so the sidebar and pane refetch. Deliberately session-wide
 * (every `diff.fileContents` chunk, not just one path's via
 * `queryCoveredPath` the way `useSetFileViewed`/`useSetRangeViewed` narrow
 * it) — unlike those two, this event doesn't say *which* file moved, only
 * that *something* did (the poller's mtime/size signal, not a diff), so
 * there's no single path to scope the invalidation to. Deliberately just an
 * invalidate, not a manual cache write — `diff-pane.tsx`'s `hashItemVersion`
 * + `FileChange.fingerprint` already make sure only files whose content
 * actually changed get a new `CodeViewItem.version`, so the virtualizer
 * leaves everything else's scroll position and highlight cache alone.
 */
export function useLiveFileChanges(
	orpc: SidecarQueryUtils,
	sessionId: string,
): void {
	const queryClient = useQueryClient();
	const eventsQuery = useQuery(orpc.events.subscribe.liveOptions());

	useEffect(() => {
		const event = eventsQuery.data;
		if (event === undefined || event.type !== "session-files-changed") return;
		if (event.sessionId !== sessionId) return;
		queryClient.invalidateQueries({
			queryKey: orpc.diff.files.key({ input: { sessionId } }),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
		});
	}, [eventsQuery.data, queryClient, orpc, sessionId]);
}
