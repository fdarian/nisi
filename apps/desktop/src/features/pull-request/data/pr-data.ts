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
import { type InferClientError, ORPCError } from "@orpc/client";
import type { SidecarClient } from "@repo/sidecar-api";
import type { Query, QueryClient, UseQueryResult } from "@tanstack/react-query";
import {
	useMutation,
	useMutationState,
	useQueries,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toastManager } from "#/components/ui/toast";
import {
	codeIndexLspIntentForStatus,
	sessionIdsForCodeIndexLspStatus,
} from "#/features/code-index/lsp/code-index-lsp-events";
import { useIncludeUncommitted } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useSidecarEvent } from "#/infra/sidecar-events";
import { useSetCodeIndexEnabled } from "./session-ui-store";

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

/**
 * The PR's GitHub page. `Session`/`SessionTarget` carry no `url`, so this
 * hardcodes `github.com` — wrong for Enterprise hosts (see
 * `packages/git/src/repo-path-mapping.ts:26`). Shared by the command
 * palette's "Open in GitHub" action and the "o g" leader shortcut
 * (`files-changed-view.tsx`) so the URL is built in exactly one place.
 */
export function pullRequestUrl(
	target: Extract<SessionTarget, { kind: "pr" }>,
): string {
	return `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`;
}

export type PullRequestUrlParts = {
	owner: string;
	repo: string;
	number: number;
};

/**
 * `pullRequestUrl`'s inverse — recognizes a GitHub PR page even with
 * trailing segments (`/files`, `/commits/<sha>`), a query string, or a
 * fragment, since that's exactly what a browser extension forwards
 * verbatim (`.../pull/12/files#discussion_r1`, see `#/shell/deep-link/deep-link.ts`).
 * Only `github.com` is recognized — the same Enterprise gap noted on
 * `pullRequestUrl` above applies here. Returns `null` rather than throwing:
 * a URL that isn't a PR link is an expected outcome for a caller parsing
 * arbitrary input, not a parse error.
 */
export function parsePullRequestUrl(url: string): PullRequestUrlParts | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.hostname !== "github.com") return null;

	const match = parsed.pathname.match(
		/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/.*)?$/,
	);
	if (match === null) return null;

	return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

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

/** Mirrors `sessions.list()` plus a `sessions.close` mutation, kept live by `events.subscribe`; root-scoped LSP status events also update every matching session's status cache and intent. */
export function useSessions(
	orpc: SidecarQueryUtils,
	/** `session-opened` is emitted by the worktree/PR open path; CLI `sessions.open` selects through `open-resolved` instead. */
	onSessionOpened: (sessionId: string) => void,
): {
	sessions: readonly Session[];
	isLoading: boolean;
	closeSession: (sessionId: string) => void;
} {
	const queryClient = useQueryClient();
	const sessionsQuery = useQuery(orpc.sessions.list.queryOptions());
	const closeMutation = useMutation({
		...orpc.sessions.close.mutationOptions(),
		onMutate: async (variables) => {
			const sessionsKey = orpc.sessions.list.queryKey();
			await queryClient.cancelQueries({ queryKey: sessionsKey });
			const previousSessions =
				queryClient.getQueryData<readonly Session[]>(sessionsKey);
			queryClient.setQueryData<readonly Session[]>(sessionsKey, (current) =>
				current === undefined
					? current
					: current.filter((session) => session.id !== variables.sessionId),
			);
			return { previousSessions };
		},
		onError: (_error, _variables, context) => {
			if (context === undefined) return;
			queryClient.setQueryData<readonly Session[]>(
				orpc.sessions.list.queryKey(),
				context.previousSessions,
			);
		},
		onSettled: () =>
			queryClient.invalidateQueries({
				queryKey: orpc.sessions.list.queryKey(),
			}),
	});
	const setCodeIndexEnabled = useSetCodeIndexEnabled();

	// Session events invalidate the list; root-scoped LSP events reconcile
	// status caches and intent for every matching tab. Native activation and
	// open-request selection are handled independently of this list cache.
	useSidecarEvent((event) => {
		if (event.type === "stream-ready" || event.type.startsWith("open-")) return;
		if (event.type === "code-index-lsp-status-changed") {
			const sessions = queryClient.getQueryData<readonly Session[]>(
				orpc.sessions.list.queryKey(),
			);
			if (sessions === undefined) return;
			for (const sessionId of sessionIdsForCodeIndexLspStatus(
				sessions,
				event,
			)) {
				queryClient.setQueryData(
					orpc.codeIndex.lspStatus.queryKey({ input: { sessionId } }),
					event.status,
				);
				setCodeIndexEnabled(
					sessionId,
					codeIndexLspIntentForStatus(event.status.status),
				);
			}
			return;
		}
		queryClient.invalidateQueries({ queryKey: orpc.sessions.list.queryKey() });
		if (event.type === "session-opened") {
			onSessionOpened(event.session.id);
		}
	});

	const closeSession = useCallback(
		(sessionId: string) => {
			closeMutation.mutate({ sessionId });
		},
		[closeMutation],
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
	// Tried inlining `combine` into the `useQueries` call below so its
	// `results` parameter's type would flow from `queries` by inference
	// instead of being hand-written here — but `queries` is a plain
	// `chunks.map(...)` array, not a tuple, so TS can't carry a per-element
	// type through `useQueries`' generic into a nested `useCallback`; the
	// inferred parameter collapsed to `never`. The explicit shape below is a
	// deliberate duplicate of `diff.fileContents`' result, not a shortcut we
	// didn't try to avoid.
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

type OptimisticRangeCall = {
	sessionId: string;
	params: SetRangeViewedParams;
	baseline?: string;
	onSuccess?: () => void;
};

export function useOptimisticRangeBaselines(
	orpc: SidecarQueryUtils,
	sessionId: string,
): ReadonlyMap<string, string> {
	const mutationKey = useMemo(
		() => orpc.review.setRangeViewed.mutationKey(),
		[orpc],
	);
	const pending = useMutationState({
		filters: { mutationKey, status: "pending" },
		select: (mutation) => mutation.state.variables as OptimisticRangeCall,
	});
	return useMemo(() => {
		const baselines = new Map<string, string>();
		for (const call of pending) {
			if (call.sessionId === sessionId && call.baseline !== undefined)
				baselines.set(call.params.path, call.baseline);
		}
		return baselines;
	}, [pending, sessionId]);
}

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
 * The hook-level success callback keeps each mark pending through both
 * refetches, and records its undo entry even if another mark starts before
 * this one finishes. Call-level callbacks only run for the latest call.
 */
export function useSetRangeViewed(
	orpc: SidecarQueryUtils,
	sessionId: string,
): (
	params: SetRangeViewedParams,
	onSuccess?: () => void,
	baseline?: string,
) => void {
	const queryClient = useQueryClient();
	const options = orpc.review.setRangeViewed.mutationOptions();
	const mutation = useMutation({
		...options,
		onMutate: undefined,
		onSettled: undefined,
		mutationFn: (call: OptimisticRangeCall, context) => {
			if (options.mutationFn === undefined)
				throw new Error("Missing range mutation function");
			return options.mutationFn(
				{ sessionId: call.sessionId, ...call.params },
				context,
			);
		},
		onSuccess: async (_data, call) => {
			call.onSuccess?.();
			await Promise.all([
				queryClient.invalidateQueries({
					queryKey: orpc.diff.files.key({
						input: { sessionId: call.sessionId },
					}),
				}),
				queryClient.invalidateQueries({
					queryKey: orpc.diff.fileContents.key({
						input: { sessionId: call.sessionId },
					}),
					predicate: (query) => queryCoveredPath(query, call.params.path),
				}),
			]);
		},
		onError: (error, call) => {
			toastManager.add({
				title: `Failed to update review state for ${call.params.path}`,
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	});

	return useCallback(
		(
			params: SetRangeViewedParams,
			onSuccess?: () => void,
			baseline?: string,
		) => {
			mutation.mutate({ sessionId, params, baseline, onSuccess });
		},
		[mutation, sessionId],
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
	const [hasPendingChanges, setHasPendingChanges] = useState(false);

	useSidecarEvent((event) => {
		if (event.type !== "session-files-changed") return;
		if (event.sessionId !== sessionId) return;
		setHasPendingChanges(true);
	});

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

export function usePullRequestAttention(
	orpc: SidecarQueryUtils,
	sessionId: string,
	watching: boolean,
): void {
	const mutation = useMutation(orpc.sessions.setAttention.mutationOptions());
	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;
	useEffect(() => {
		mutateRef.current({ sessionId, watched: watching });
		return () => mutateRef.current({ sessionId, watched: false });
	}, [sessionId, watching]);
}

/**
 * `sessions.switchToPr` — the ⌘K "Switch to PR" command available on a
 * branch-diff session, resolving to whatever PR GitHub knows about for the
 * branch (`resolveReviewTarget`, `apps/desktop/sidecar/store.ts`).
 * Transforms `sessionId`'s own tab in place — same session id, so its
 * tracked-changes state and any generated walkthrough carry over — rather
 * than `sessions.open`'s `{ target: { kind: "pr" } }`, which would leave the
 * branch tab open and mint a second, unrelated one alongside it. `onOpened`
 * still works for both outcomes the sidecar can answer with: the same
 * session id back (retargeted in place) or a different, pre-existing PR
 * session's id (another session already held that PR — see the contract's
 * doc comment) — either way it's the id to activate.
 *
 * Errors toast rather than return — a command-palette action has no
 * dedicated place to render an inline error, matching
 * `useMarkPullRequestReady`. "No PR open" is `sessions.switchToPr`'s own
 * `NOT_FOUND` code (`packages/sidecar-api/src/sessions.ts`) — distinct from
 * `BAD_REQUEST`, which that contract reserves for a GitHub-resolution
 * failure on the branch's default-branch fallback.
 */
export function useSwitchToPr(
	orpc: SidecarQueryUtils,
	onOpened: (sessionId: string) => void,
): {
	switchToPr: (sessionId: string) => void;
	isPending: boolean;
} {
	const mutation = useMutation({
		...orpc.sessions.switchToPr.mutationOptions(),
		onSuccess: (session) => onOpened(session.id),
		onError: (error) => {
			const isNoPullRequest =
				error instanceof ORPCError && error.code === "NOT_FOUND";
			toastManager.add({
				title: isNoPullRequest
					? "No pull request found for this branch."
					: "Failed to switch to pull request",
				description: isNoPullRequest
					? undefined
					: error instanceof Error
						? error.message
						: String(error),
				type: "error",
			});
		},
	});

	return {
		switchToPr: (sessionId: string) => {
			mutation.mutate({ sessionId });
		},
		isPending: mutation.isPending,
	};
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

/** Mirrors `PullRequestStack` (`packages/sidecar-api/src/pull-requests.ts`). */
export type PullRequestStackEntry = {
	position: number;
	number: number;
	title: string;
	headRefName: string;
	baseRefName: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
};

export type PullRequestStack = {
	number: number;
	size: number;
	baseRefName: string;
	position: number;
	entries: readonly PullRequestStackEntry[];
};

export type PullRequestMergeStatusParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

export function usePullRequestMergeStatus(
	orpc: SidecarQueryUtils,
	params: PullRequestMergeStatusParams,
): UseQueryResult<PullRequestMergeStatus> {
	return useQuery(orpc.pullRequests.mergeStatus.liveOptions({ input: params }));
}

const MERGE_STATUS_WAIT_MS = 15000;

/** Keep the merge pending until the same live cache entry the button reads reports MERGED. */
export function waitForMergedStatus(
	queryClient: QueryClient,
	orpc: SidecarQueryUtils,
	params: PullRequestMergeStatusParams,
	timeoutMs = MERGE_STATUS_WAIT_MS,
): Promise<void> {
	const key = orpc.pullRequests.mergeStatus.liveKey({ input: params });
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timeout);
			unsubscribe();
			resolve();
		};
		const isMerged = () =>
			queryClient.getQueryData<PullRequestMergeStatus>(key)?.state === "MERGED";
		if (isMerged()) {
			resolve();
			return;
		}
		const unsubscribe = queryClient.getQueryCache().subscribe(() => {
			if (isMerged()) finish();
		});
		const timeout = setTimeout(finish, timeoutMs);
		if (isMerged()) finish();
	});
}

export type PullRequestStackParams = {
	owner: string;
	repo: string;
	number: number;
};

export function usePullRequestStack(
	orpc: SidecarQueryUtils,
	params: PullRequestStackParams,
): UseQueryResult<PullRequestStack | null> {
	return useQuery(orpc.pullRequests.stack.liveOptions({ input: params }));
}

export type MergePullRequestParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	method: MergeMethod;
};

export type MergePullRequestError =
	| InferClientError<SidecarClient["pullRequests"]["merge"]>
	| Error;

/** Keep mutations pending through the adapter's post-merge live status refresh. */
export function useMergePullRequest(
	orpc: SidecarQueryUtils,
	onError: (
		error: MergePullRequestError,
		params: MergePullRequestParams,
	) => void,
): {
	merge: (params: MergePullRequestParams) => void;
	mergeStack: (params: MergePullRequestParams) => void;
	isPending: boolean;
} {
	const queryClient = useQueryClient();

	const onSuccess = useCallback(
		async (params: MergePullRequestParams) => {
			await queryClient.invalidateQueries({
				queryKey: orpc.sessions.list.queryKey(),
			});
			await waitForMergedStatus(queryClient, orpc, params);
		},
		[queryClient, orpc],
	);
	const mutation = useMutation({
		...orpc.pullRequests.merge.mutationOptions(),
		onSuccess: (_data, params) => onSuccess(params),
		onError,
	});
	const stackMutation = useMutation({
		...orpc.pullRequests.mergeStack.mutationOptions(),
		onSuccess: (_data, params) => onSuccess(params),
		onError,
	});

	const merge = useCallback(
		(params: MergePullRequestParams) => {
			mutation.mutate(params);
		},
		[mutation],
	);

	const mergeStack = useCallback(
		(params: MergePullRequestParams) => {
			stackMutation.mutate(params);
		},
		[stackMutation],
	);

	return {
		merge,
		mergeStack,
		isPending: mutation.isPending || stackMutation.isPending,
	};
}

export type MarkPullRequestReadyParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

/** `owner`/`repo` identify the adapter's live sources to refresh after marking ready. */
export function useMarkPullRequestReady(orpc: SidecarQueryUtils): {
	markReady: (params: MarkPullRequestReadyParams) => void;
	isPending: boolean;
} {
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
		(params: MarkPullRequestReadyParams) => mutation.mutate(params),
		[mutation],
	);

	return { markReady, isPending: mutation.isPending };
}

/** Mirrors `PullRequestCheckStatus` (`packages/sidecar-api/src/pull-requests.ts`). */
export type PullRequestCheckStatus =
	| "passing"
	| "failing"
	| "awaiting_approval"
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
	workflowRunId?: number;
};

export type ApproveWorkflowRunsParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	runIds: readonly number[];
};

export type ApproveWorkflowRunsError =
	| InferClientError<SidecarClient["pullRequests"]["approveWorkflowRuns"]>
	| Error;

export function useApproveWorkflowRuns(
	orpc: SidecarQueryUtils,
	onError: (error: ApproveWorkflowRunsError) => void,
): {
	approve: (params: ApproveWorkflowRunsParams) => void;
	isPending: boolean;
} {
	const queryClient = useQueryClient();
	const refreshChecks = (params: ApproveWorkflowRunsParams) =>
		queryClient.invalidateQueries({
			queryKey: orpc.pullRequests.checks.key({
				input: {
					repoRoot: params.repoRoot,
					owner: params.owner,
					repo: params.repo,
					number: params.number,
				},
			}),
		});
	const mutation = useMutation({
		...orpc.pullRequests.approveWorkflowRuns.mutationOptions(),
		onSuccess: (_data, params) => refreshChecks(params),
		onError: (error, params) => {
			onError(error);
			void refreshChecks(params);
		},
	});
	return {
		approve: (params) => mutation.mutate(params),
		isPending: mutation.isPending,
	};
}

export type PullRequestChecksParams = {
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

export function usePullRequestChecks(
	orpc: SidecarQueryUtils,
	params: PullRequestChecksParams,
): UseQueryResult<readonly PullRequestCheck[]> {
	return useQuery(orpc.pullRequests.checks.liveOptions({ input: params }));
}

/**
 * Mirrors `OverviewCheck` (`packages/sidecar-api/src/overview.ts`) — one CI
 * check on a single commit. Deliberately the same field shape as
 * `ci-status.tsx`'s `CiCheck` (name/status/detail/detailsUrl), so a commit's
 * `checks` array passes straight into `CiStatusIcon` with no mapping step,
 * unlike `PullRequestCheck` above (`durationMs`/`workflowName` need
 * `pr-ci-status.tsx`'s `toCiChecks`).
 */
export type OverviewCheck = {
	name: string;
	status: PullRequestCheckStatus;
	detail?: string;
	detailsUrl?: string;
};

/**
 * Mirrors `OverviewCommit` — one commit in the Overview tab's list.
 * `authorLogin`/`url`/`checks` are all `null` for a branch/diff session: a
 * plain `git log` has no GitHub identity or CI data to attach.
 */
export type OverviewCommit = {
	sha: string;
	shortSha: string;
	headline: string;
	body: string | null;
	authorName: string;
	authorLogin: string | null;
	committedDate: string;
	url: string | null;
	checks: readonly OverviewCheck[] | null;
};

/** Mirrors `OverviewDescription` — `null` for a branch/diff session, which has no PR to describe. */
export type OverviewDescription = {
	authorLogin: string;
	body: string | null;
};

/** Mirrors `OverviewResult` — `overview.get`'s output. */
export type Overview = {
	description: OverviewDescription | null;
	/** Oldest-first, matching GitHub's own PR commits tab. */
	commits: readonly OverviewCommit[];
};

export function useOverview(
	orpc: SidecarQueryUtils,
	session: Session,
): UseQueryResult<Overview> {
	const target = session.target;
	const input =
		target.kind === "pr"
			? {
					repoRoot: session.repoRoot,
					kind: "pr" as const,
					owner: target.owner,
					repo: target.repo,
					number: target.number,
				}
			: {
					repoRoot: session.repoRoot,
					kind: "branch" as const,
					sessionId: session.id,
					baseRef: target.baseRef,
					headRef: target.headRef,
				};

	return useQuery(orpc.overview.get.liveOptions({ input }));
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
