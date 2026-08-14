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
import { ORPCError } from "@orpc/client";
import type { Query, UseQueryResult } from "@tanstack/react-query";
import {
	useMutation,
	useMutationState,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useIncludeUncommitted } from "#/lib/settings-data";

/**
 * What a session is actually reviewing — mirrors `SessionTarget`
 * (`packages/sidecar-api/src/sessions.ts`). `"pr"` is a real open pull
 * request; `"branch"` covers every other case (no PR, or an explicit
 * `nisi diff <base>`) and still carries its own `baseRef`/`headRef` rather
 * than leaving them at the `Session` level.
 */
export type SessionTarget =
	| {
			kind: "pr";
			number: number;
			title: string;
			baseRef: string;
			headRef: string;
			owner: string;
			repo: string;
	  }
	| { kind: "branch"; baseRef: string; headRef: string };

export type Session = {
	id: string;
	repoRoot: string;
	target: SessionTarget;
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

/**
 * Mirrors `FileContentReview` — present whenever the file has any active
 * review claim, whole-file or block-scoped. `baselineKind` says which file
 * `FileContent.patch`/`oldContent` are actually diffed against: `"reviewed"`
 * means the sidecar substituted the synthesized reviewed-state baseline for
 * the usual merge-base content, so an *empty* patch means "nothing new since
 * your last pass," not "nothing changed in the PR."
 */
export type FileContentReview = {
	changedSinceReview: boolean;
	ranges: readonly ReviewRange[];
	baselineKind: "base" | "reviewed";
};

export type FileContent = {
	patch: string;
	oldContent?: string;
	newContent?: string;
	truncated: boolean;
	review: FileContentReview | null;
};

/** `useFileContents`' return shape — named so callers threading it through (e.g. `FilesChangedView` lifting the hook and passing it down to `DiffPane`, plus its own keyword-search predicate) don't each redeclare the inline map type. */
export type FileContentsMap = ReadonlyMap<
	string,
	{ content: FileContent | undefined; isLoading: boolean; isError: boolean }
>;

export type ReviewState = "unreviewed" | "viewed" | "changed-after-review";

/** `useReviewState`'s per-file entry — `status` is the three-value read described on that hook. */
export type ReviewStateEntry = {
	status: ReviewState;
};

/** Mirrors `sessions.list()` plus a `sessions.close` mutation, kept live by `events.subscribe`. */
export function useSessions(
	orpc: SidecarQueryUtils,
	/** Fires when a `session-opened` event arrives — the caller sets `requestedActiveSessionId` (`app-shell.tsx`) so a CLI-opened tab activates the same way `OpenPullRequestPalette`'s `onSessionOpened` does for the in-app path. */
	onSessionOpened: (sessionId: string) => void,
): {
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
	// `session-opened` additionally requests activation, since that's the one
	// event whose whole point is a tab the user hasn't looked at yet.
	const eventsQuery = useQuery(orpc.events.subscribe.liveOptions());
	useEffect(() => {
		if (eventsQuery.data === undefined) return;
		queryClient.invalidateQueries({ queryKey: orpc.sessions.list.queryKey() });
		if (eventsQuery.data.type === "session-opened") {
			onSessionOpened(eventsQuery.data.session.id);
		}
	}, [eventsQuery.data, queryClient, orpc, onSessionOpened]);

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
): FileContentsMap {
	const [includeUncommitted] = useIncludeUncommitted(orpc);
	const chunks = useMemo(
		() => chunkPaths(paths, FILE_CONTENTS_CHUNK_SIZE),
		[paths],
	);

	// Plain `useQueries` (no `combine`) hands back a fresh `matches.map(...)`
	// array on every render — query-core's `QueriesObserver.getOptimisticResult`
	// only memoizes through `#combineResult`, and that path is skipped
	// entirely when no `combine` is passed (see
	// `@tanstack/query-core`'s `queriesObserver.js`). That fresh array used to
	// flow straight into a `useMemo` building the `FileContentsMap` below, so
	// the map got a new identity every render of `FilesChangedView` even when
	// nothing had actually changed — which in turn defeated `DiffPane`'s
	// `items` memo and the keyword-search memos in `files-changed-view.tsx`
	// that depend on this map.
	//
	// `combine` fixes that at the source: `#combineResult` caches
	// `#combinedResult` and only recomputes when its *own* tracked
	// `results`/`queryHashes`/`combine` change — not via `replaceEqualDeep`
	// (which can't structurally compare a `Map`, so it would just hand back
	// the new one). That cache is keyed in part on `combine`'s own identity,
	// so `combine` itself has to be stable across renders — hence
	// `useCallback`, closing over `chunks` (already memoized on `paths`)
	// rather than `paths` directly.
	const combineFileContents = useCallback(
		(
			results: readonly {
				data:
					| readonly { path: string; content: FileContent | null }[]
					| undefined;
				isLoading: boolean;
				isError: boolean;
				isSuccess: boolean;
			}[],
		): FileContentsMap => {
			const map = new Map<
				string,
				{
					content: FileContent | undefined;
					isLoading: boolean;
					isError: boolean;
				}
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
		},
		[chunks],
	);

	return useQueries({
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
		combine: combineFileContents,
	});
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
): ReadonlyMap<string, ReviewStateEntry> {
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

		const map = new Map<string, ReviewStateEntry>();
		for (const file of files) {
			const pendingViewed = pendingByPath.get(file.path);
			if (pendingViewed !== undefined) {
				map.set(file.path, {
					status: pendingViewed ? "viewed" : "unreviewed",
				});
				continue;
			}
			if (file.review === null) continue;
			map.set(file.path, {
				status: file.review.changedSinceReview
					? "changed-after-review"
					: "viewed",
			});
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
 *
 * `onSuccess` returns the invalidations' promises rather than firing them off
 * — TanStack Query keeps a mutation `"pending"` until a promise returned from
 * `onSuccess` settles, so `useReviewState`'s overlay (matched on that same
 * `"pending"` status) stays live until `diff.files`/this file's
 * `diff.fileContents` chunk have actually refetched, not just until the
 * write itself resolved. Dropping the overlay any earlier would open a
 * window where it's cleared but the fresh server data hasn't landed yet —
 * the checkbox would render the stale pre-click value for a frame before the
 * refetch caught up, i.e. the flicker this is closing.
 *
 * That `onSuccess` is wired into `useMutation`'s own options, not `.mutate()`'s
 * second argument, and that split is load-bearing, not style: TanStack
 * Query only awaits the *hook-level* `onSuccess` (`this.options.onSuccess`
 * inside `Mutation#execute`) before dispatching `"success"` — the
 * *call-level* one passed to `.mutate(vars, { onSuccess })` runs from
 * `MutationObserver#notify`, itself invoked from `onMutationUpdate` *after*
 * that dispatch already flipped `state.status`. A call-level `onSuccess`
 * returning a promise therefore delays nothing; `useReviewState`'s overlay
 * would still drop the instant the write resolves, before either
 * invalidation lands — the exact flicker this hook exists to close. Confirmed
 * against `node_modules/.../@tanstack/query-core/build/modern/mutation.js`
 * and `mutationObserver.js` and against a real click in the browser dev
 * harness (`apps/desktop/CLAUDE.md`): a call-level `onSuccess` shows the
 * overlay clearing (`pending=[]`) within ~5ms of the write resolving, while
 * `diff.files` still holds the pre-click value for another ~150ms. Moving
 * this back to `.mutate()`'s call site — e.g. to read `path` from the closure
 * again instead of `variables` — type-checks fine and no test catches it;
 * it just silently reopens that ~150ms window.
 *
 * `onError` needs no rollback of its own: the overlay above is driven purely
 * by `useMutationState`'s `status: "pending"` filter, never an imperative
 * cache write, so the instant this mutation settles — success *or* error —
 * `useReviewState` stops predicting and falls back to whatever `diff.files`
 * already said, which a failed write never touched. The toast here is purely
 * user feedback for a failure that would otherwise be silent (`NOT_FOUND` or
 * `INTERNAL_SERVER_ERROR` alike — both are `ORPCError`s, so `.message`
 * covers either without discriminating on the tag).
 */
export function useSetFileViewed(
	orpc: SidecarQueryUtils,
	sessionId: string,
): (path: string, viewed: boolean) => void {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		...orpc.review.setViewed.mutationOptions(),
		onSuccess: (_data, variables) =>
			Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.diff.files.key({ input: { sessionId } }),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
					predicate: (query) => queryCoveredPath(query, variables.path),
				}),
			]),
		onError: (error, variables) => {
			toastManager.add({
				title: `Failed to update review state for ${variables.path}`,
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	});

	return useCallback(
		(path: string, viewed: boolean) => {
			mutation.mutate({ sessionId, path, viewed });
		},
		[mutation, sessionId],
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
 *
 * Deliberately keeps the fire-and-forget call-level `onSuccess` shape
 * `useSetFileViewed` moved away from — this mutation's key isn't what
 * `useReviewState`'s `useMutationState` filter matches, so there's no
 * optimistic overlay riding on it to protect from a premature drop. If a
 * range-scoped overlay is ever added, it needs the same hook-level
 * `onSuccess` treatment (see `useSetFileViewed`'s doc comment) — a
 * call-level one won't delay the mutation's `"pending"` → `"success"`
 * transition no matter what it returns.
 *
 * `onError` is call-level too, for the same reason `onSuccess` is: there's
 * no overlay here for a failure to leave stuck, so nothing needs the
 * hook-level await-before-transition timing — just a toast so a failed tick
 * (`NOT_FOUND` or `INTERNAL_SERVER_ERROR`) doesn't fail silently.
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
					onError: (error) => {
						toastManager.add({
							title: `Failed to update review state for ${params.path}`,
							description:
								error instanceof Error ? error.message : String(error),
							type: "error",
						});
					},
				},
			);
		},
		[mutation, queryClient, orpc, sessionId],
	);
}

export type LiveFileChanges = {
	hasPendingChanges: boolean;
	refresh: () => void;
};

/**
 * Tracks whether `diff.files`/`diff.fileContents` have gone stale: on the
 * sidecar's `session-files-changed` event (the 2s worktree poller noticing a
 * change — see `packages/sidecar-api/src/events.ts`) for *this* session, sets
 * `hasPendingChanges` instead of invalidating right away, so the caller can
 * surface a "Refresh" affordance rather than yanking the diff out from under
 * whoever's reading it. Calling `refresh` invalidates both queries so the
 * sidebar and pane refetch, and clears the flag — a later event re-sets it.
 * Deliberately session-wide (every `diff.fileContents` chunk, not just one
 * path's via `queryCoveredPath` the way `useSetFileViewed`/`useSetRangeViewed`
 * narrow it) — unlike those two, this event doesn't say *which* file moved,
 * only that *something* did (the poller's mtime/size signal, not a diff), so
 * there's no single path to scope the invalidation to. Deliberately just an
 * invalidate, not a manual cache write — `diff-pane.tsx`'s `hashItemVersion`
 * + `FileChange.fingerprint` already make sure only files whose content
 * actually changed get a new `CodeViewItem.version`, so the virtualizer
 * leaves everything else's scroll position and highlight cache alone.
 */
export function useLiveFileChanges(
	orpc: SidecarQueryUtils,
	sessionId: string,
): LiveFileChanges {
	const queryClient = useQueryClient();
	const eventsQuery = useQuery(orpc.events.subscribe.liveOptions());
	const [hasPendingChanges, setHasPendingChanges] = useState(false);

	useEffect(() => {
		const event = eventsQuery.data;
		if (event === undefined || event.type !== "session-files-changed") return;
		if (event.sessionId !== sessionId) return;
		setHasPendingChanges(true);
	}, [eventsQuery.data, sessionId]);

	const refresh = useCallback(() => {
		queryClient.invalidateQueries({
			queryKey: orpc.diff.files.key({ input: { sessionId } }),
		});
		queryClient.invalidateQueries({
			queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
		});
		setHasPendingChanges(false);
	}, [queryClient, orpc, sessionId]);

	return { hasPendingChanges, refresh };
}

/**
 * Drives `sessions.setWatching` from a computed `watched` predicate — the
 * frontend half of the poll-gating this session's `live-poll.ts` enforces on
 * the sidecar side. `watched` is meant to be `windowFocused && activeTab ===
 * "files" && this PrView is the selected PR tab` (see `pr-view.tsx`), so the
 * sidecar's 2s poller only checks a session while its Files Changed tab is
 * actually on screen for someone to see the result. Fires the mutation only
 * on an actual change to `watched` (never on every render, via the `ref`
 * below) and sends a final `false` on unmount, so backgrounding the tab or
 * closing it actually stops the poll rather than leaking a watch entry until
 * `sessions.close` cleans it up on its own schedule.
 */
export function useSessionWatch(
	orpc: SidecarQueryUtils,
	sessionId: string,
	watched: boolean,
): void {
	const mutation = useMutation(orpc.sessions.setWatching.mutationOptions());
	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;

	// `mutation.mutate` gets a new identity on every render (a fresh
	// `useMutation()` object) — routing every call through `mutateRef` keeps
	// this effect's own deps down to just `sessionId`/`watched`, so it fires
	// only on an actual change to the watch predicate, not on every render.
	useEffect(() => {
		mutateRef.current({ sessionId, watching: watched });
		return () => {
			mutateRef.current({ sessionId, watching: false });
		};
	}, [sessionId, watched]);
}

/**
 * Calls `refresh` on the false→true rising edge of `watched` — in
 * `pr-view.tsx`, `watched` is `windowFocused && isFilesChangedVisible`, so
 * that one edge is exactly the union of the two transitions Files Changed
 * should refetch on: switching into this PR's tab while the window is
 * focused, and regaining window focus while this tab is already the visible
 * one. Takes `refresh` rather than reimplementing the invalidation — reuses
 * `useLiveFileChanges`'s own `refresh`, which already covers both
 * `diff.files`/`diff.fileContents` and clears `hasPendingChanges`, correct
 * here since a refetch just applied everything that flag was announcing.
 *
 * Seeds the "previous" ref from `watched` itself, not `false` — an app that
 * opens already focused with Files Changed active starts `watched` at
 * `true`, and that initial value must not read as a rising edge (the query
 * is already loading on its own; firing `refresh` on top of it would be a
 * redundant, mount-time refetch, not a real transition).
 */
export function useRefreshOnWatchedEdge(
	watched: boolean,
	refresh: () => void,
): void {
	const previouslyWatched = useRef(watched);

	useEffect(() => {
		if (!previouslyWatched.current && watched) {
			refresh();
		}
		previouslyWatched.current = watched;
	}, [watched, refresh]);
}

/** Mirrors `MergeMethod` (`packages/sidecar-api/src/pull-requests.ts`) — the merge strategy GitHub's own PR UI offers, in its own Merge → Squash → Rebase ordering. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** Mirrors `PullRequestMergeStatus` (`packages/sidecar-api/src/pull-requests.ts`). */
export type PullRequestMergeStatus = {
	state: "OPEN" | "CLOSED" | "MERGED";
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	mergeStateStatus:
		| "BEHIND"
		| "BLOCKED"
		| "CLEAN"
		| "DIRTY"
		| "DRAFT"
		| "HAS_HOOKS"
		| "UNKNOWN"
		| "UNSTABLE";
	isDraft: boolean;
	allowedMethods: readonly MergeMethod[];
	defaultMethod: MergeMethod;
};

export type PullRequestMergeStatusParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

/**
 * `pullRequests.mergeStatus` — PR mergeability plus the repo's enabled merge
 * methods in one query, everything the PR header's Merge button needs to
 * decide its label/enabled state and its method picker. GitHub computes
 * `mergeable` asynchronously, so this re-polls every 2s while it's still
 * `"UNKNOWN"` rather than leaving the button stuck on "Checking
 * mergeability…" until something else happens to trigger a refetch —
 * `false` (TanStack Query's "stop polling") the instant it resolves either
 * way. Once the PR itself is no longer open, GitHub stops computing
 * `mergeable` at all and it stays `"UNKNOWN"` forever — checking `state`
 * first is what stops a merged/closed PR from being polled every 2s for the
 * rest of the session.
 */
export function usePullRequestMergeStatus(
	orpc: SidecarQueryUtils,
	params: PullRequestMergeStatusParams,
): UseQueryResult<PullRequestMergeStatus> {
	return useQuery({
		...orpc.pullRequests.mergeStatus.queryOptions({ input: params }),
		refetchInterval: (query) =>
			query.state.data?.state === "OPEN" &&
			query.state.data.mergeable === "UNKNOWN"
				? 2000
				: false,
	});
}

export type MergePullRequestParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	method: MergeMethod;
};

/**
 * `pullRequests.merge` — fires `gh pr merge` with the caller's chosen
 * method. On success invalidates this PR's own `mergeStatus` (flips the
 * button to "Merged") and the sessions list, mirroring `useSetRangeViewed`'s
 * fire-and-forget call-level `onSuccess` shape: unlike `useSetFileViewed`,
 * nothing elsewhere reads this mutation's `"pending"` state via
 * `useMutationState`, so there's no overlay whose timing a hook-level
 * `onSuccess` would need to protect.
 */
export function useMergePullRequest(orpc: SidecarQueryUtils): {
	merge: (params: MergePullRequestParams) => void;
	isPending: boolean;
	error: unknown;
} {
	const queryClient = useQueryClient();
	const mutation = useMutation(orpc.pullRequests.merge.mutationOptions());

	const merge = useCallback(
		(params: MergePullRequestParams) => {
			mutation.mutate(params, {
				onSuccess: () => {
					queryClient.invalidateQueries({
						queryKey: orpc.pullRequests.mergeStatus.key({
							input: {
								repoRoot: params.repoRoot,
								owner: params.owner,
								repo: params.repo,
								number: params.number,
							},
						}),
					});
					queryClient.invalidateQueries({
						queryKey: orpc.sessions.list.queryKey(),
					});
				},
			});
		},
		[mutation, queryClient, orpc],
	);

	return { merge, isPending: mutation.isPending, error: mutation.error };
}

export type MarkPullRequestReadyParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

/**
 * `pullRequests.markReady` — fires `gh pr ready`, flipping a draft PR to
 * ready for review. `owner`/`repo` aren't part of the wire call itself (`gh
 * pr ready` only needs `repoRoot`/`number`), but are threaded through so the
 * success handler can invalidate this PR's own `mergeStatus` — the same
 * query `useMergePullRequest` invalidates, since `isDraft` drives both the
 * header's menu-item visibility and the merge button's own draft label, and
 * both must update without a manual refresh. On failure, surfaces a toast
 * rather than touching any cached state — there's nothing honest to predict
 * client-side about draft status before the round trip resolves.
 */
export function useMarkPullRequestReady(orpc: SidecarQueryUtils): {
	markReady: (params: MarkPullRequestReadyParams) => void;
	isPending: boolean;
} {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		...orpc.pullRequests.markReady.mutationOptions(),
		onError: (error) => {
			toastManager.add({
				title: "Failed to mark pull request ready for review",
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	});

	const markReady = useCallback(
		(params: MarkPullRequestReadyParams) => {
			mutation.mutate(
				{ repoRoot: params.repoRoot, number: params.number },
				{
					onSuccess: () => {
						queryClient.invalidateQueries({
							queryKey: orpc.pullRequests.mergeStatus.key({
								input: {
									repoRoot: params.repoRoot,
									owner: params.owner,
									repo: params.repo,
									number: params.number,
								},
							}),
						});
					},
				},
			);
		},
		[mutation, queryClient, orpc],
	);

	return { markReady, isPending: mutation.isPending };
}

/** Mirrors `PullRequestCheckStatus` (`packages/sidecar-api/src/pull-requests.ts`) — the 5-state vocabulary `ci-status.tsx`'s `CiCheckStatus` renders. */
export type PullRequestCheckStatus =
	| "passing"
	| "failing"
	| "running"
	| "pending"
	| "skipped";

/**
 * Mirrors `PullRequestCheck` (`packages/sidecar-api/src/pull-requests.ts`).
 * Deliberately *not* shaped like `ci-status.tsx`'s `CiCheck` — `durationMs`
 * is a fact, not the formatted `detail` string `CiCheck` wants. Turning one
 * into the other is `pr-ci-status.tsx`'s job (the wrapper stops being a
 * pass-through and does that mapping), which is where a presentation
 * decision like "how does a duration read" belongs — not this data layer.
 * `workflowName` is the same story for `name`: `gh` reports a `CheckRun`'s
 * bare job name, which two different workflows can share — only
 * `pr-ci-status.tsx`, seeing every check in the set at once, can tell which
 * ones actually need disambiguating.
 */
export type PullRequestCheck = {
	name: string;
	status: PullRequestCheckStatus;
	durationMs?: number;
	detailsUrl?: string;
	workflowName?: string;
};

export type PullRequestChecksParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

/**
 * `pullRequests.checks` — every CI check attached to the PR, backing the
 * header's `CiStatus` ring. Polls only while something is still unsettled
 * (any check `"running"`/`"pending"`) — unlike `usePullRequestMergeStatus`'s
 * 2s cadence, CI is slow (real pipelines run minutes, not seconds), so a
 * tight poll would just spam the sidecar with `gh pr view` calls for no
 * visible benefit. `false` (TanStack Query's "stop polling") once every
 * check has settled, same as a query that never had anything in flight (a PR
 * with zero checks, or every check already passing/failing/skipped).
 */
export function usePullRequestChecks(
	orpc: SidecarQueryUtils,
	params: PullRequestChecksParams,
): UseQueryResult<readonly PullRequestCheck[]> {
	return useQuery({
		...orpc.pullRequests.checks.queryOptions({ input: params }),
		refetchInterval: (query) =>
			query.state.data?.some(
				(check) => check.status === "running" || check.status === "pending",
			) === true
				? 10000
				: false,
	});
}

/**
 * `pullRequests.unpushedCommits`'s result, collapsed to what the pre-merge
 * dialog actually branches on. `"unpushed"` is the real "some commits won't
 * be in this merge" case; `"unverifiable"` folds every failure mode
 * (`NO_REMOTE_REF` — no `@{upstream}` and no matching `origin/<branch>` to
 * diff against — and anything undeclared, like the sidecar being
 * unreachable) into one outcome, since the caller shows the same
 * confirmation dialog either way, just worded as "couldn't verify" instead
 * of naming a count. An unverifiable state is exactly what the user needs to
 * see before merging — silently treating it as clean would defeat the
 * feature the same way a stale cached count would.
 */
export type UnpushedCommitsCheck =
	| { status: "clean" }
	| { status: "unpushed"; count: number; remoteRef: string }
	| { status: "unverifiable"; message: string };

/** `pullRequests.unpushedCommits`'s declared `NO_REMOTE_REF` carries no server-authored message (there's nothing to diff against, not a failure with detail) — named explicitly rather than falling through to `mergeStatusErrorMessage`'s generic copy. Anything else undeclared (sidecar unreachable) still gets that generic fallback. */
const unpushedCommitsErrorMessage = (error: unknown): string => {
	if (error instanceof ORPCError && error.code === "NO_REMOTE_REF") {
		return "This branch has no remote to compare against.";
	}
	if (error instanceof ORPCError && typeof error.message === "string") {
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return "Couldn't check whether every local commit has been pushed.";
};

/**
 * `pullRequests.unpushedCommits` fired as a plain mutation rather than a
 * `useQuery` — the Merge button needs a *fresh* round trip at click time to
 * catch commits made moments before clicking, and a cached/polled query is
 * exactly the failure mode that would defeat that (TanStack Query could
 * serve a click a count that's seconds or minutes stale). `check` resolves
 * rather than throws on failure — `UnpushedCommitsCheck`'s `"unverifiable"`
 * branch is a real outcome the caller renders, not an exceptional one.
 */
export function useUnpushedCommitsCheck(orpc: SidecarQueryUtils): {
	check: (repoRoot: string) => Promise<UnpushedCommitsCheck>;
	isPending: boolean;
} {
	const mutation = useMutation(
		orpc.pullRequests.unpushedCommits.mutationOptions(),
	);

	const check = useCallback(
		async (repoRoot: string): Promise<UnpushedCommitsCheck> => {
			try {
				const result = await mutation.mutateAsync({ repoRoot });
				return result.count === 0
					? { status: "clean" }
					: {
							status: "unpushed",
							count: result.count,
							remoteRef: result.remoteRef,
						};
			} catch (error) {
				return {
					status: "unverifiable",
					message: unpushedCommitsErrorMessage(error),
				};
			}
		},
		[mutation],
	);

	return { check, isPending: mutation.isPending };
}
