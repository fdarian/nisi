import { useCallback, useEffect, useMemo, useState } from "react";
import type { HeadRange } from "#/features/diff/selection/selection-head-range";
import { demandedFileContentChunks } from "#/features/pull-request/data/file-content-demand";
import type {
	FileChange,
	FileContent,
	FileContentsMap,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import {
	useFileContents,
	useOptimisticRangeBaselines,
	useSetRangeViewed,
} from "#/features/pull-request/data/pr-data";
import {
	useSessionDemandedFileContentChunks,
	useSessionForcedPaths,
	useSessionUndoStack,
} from "#/features/pull-request/data/session-ui-store";
import { useHideReviewed } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { comparePaths } from "#/lib/tree-paths";
import { optimisticRangeBaseline } from "./optimistic-range-baseline";

/**
 * Everything `DiffPane` needs besides the file list itself and the review
 * setters, assembled once for both panes that render it: Files Changed and
 * the Guide's side pane. `files` is whatever set the pane covers (the whole
 * PR, or one Area's files); contents, chunk demand, hide-reviewed filtering
 * and the range-review path all derive from it.
 */
export function useDiffPaneData(params: {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	/** Its content chunk is fetched even while the pane hasn't rendered it yet. */
	selectedPath: string | null;
	/** Keyword search greps every file's content, so every chunk is demanded. */
	demandAllContent: boolean;
}) {
	const orpc = params.orpc;
	const sessionId = params.sessionId;
	const files = params.files;
	const reviewState = params.reviewState;
	const hideReviewed = useHideReviewed(orpc)[0];

	const rangeReview = useRangeReview(orpc, sessionId, files);
	const optimisticBaselines = rangeReview.optimisticBaselines;

	const viewedCount = useMemo(
		() =>
			files.filter((file) => reviewState.get(file.path)?.status === "viewed")
				.length,
		[files, reviewState],
	);

	// Lifted from `DiffPane` (rather than duplicated) — Files Changed's keyword-search
	// predicate and the diff pane's own rendering need to read the
	// exact same `useFileContents` call so TanStack Query dedupes both to one
	// cached entry per chunk instead of mounting two independently-chunked
	// fetches. `contentPaths` deliberately comes from `files` (the unfiltered
	// prop), not `visibleFiles`/`queryFilteredFiles` below, for the same
	// reason `DiffPane` used to key its chunks off `allFiles`: a file
	// dropping out of the filtered/hide-reviewed view must never reshuffle
	// another chunk's boundary. DiffPane sorts by comparePaths, so use that
	// same display order even when the incoming files aren't sorted.
	const contentPaths = useMemo(
		() =>
			files
				.filter((file) => !file.binary)
				.map((file) => file.path)
				.sort(comparePaths),
		[files],
	);
	const [renderedPaths, setRenderedPaths] = useState<readonly string[] | null>(
		null,
	);
	// Unlike the virtualizer's current window, enabled chunks survive tab suspension.
	const [stickyChunks, addDemandedChunks] =
		useSessionDemandedFileContentChunks(sessionId);
	const demandedChunks = useMemo(() => {
		const wanted = demandedFileContentChunks(
			contentPaths,
			renderedPaths,
			params.selectedPath,
			params.demandAllContent,
		);
		return new Set([...stickyChunks, ...wanted]);
	}, [
		contentPaths,
		renderedPaths,
		params.selectedPath,
		params.demandAllContent,
		stickyChunks,
	]);
	useEffect(() => {
		if (stickyChunks.size !== demandedChunks.size)
			addDemandedChunks(demandedChunks);
	}, [stickyChunks, demandedChunks, addDemandedChunks]);
	const handleRenderedPathsChange = useCallback((paths: readonly string[]) => {
		setRenderedPaths((current) =>
			current !== null &&
			current.length === paths.length &&
			current.every((path, index) => path === paths[index])
				? current
				: paths,
		);
	}, []);
	const [forcedPaths, addForcedPath] = useSessionForcedPaths(sessionId);
	const fileContents: FileContentsMap = useFileContents(
		orpc,
		sessionId,
		contentPaths,
		forcedPaths,
		demandedChunks,
	);
	const visibleFiles = useMemo(() => {
		const filtered = hideReviewed
			? files.filter(
					(file) =>
						reviewState.get(file.path)?.status !== "viewed" ||
						(optimisticBaselines.has(file.path) &&
							optimisticBaselines.get(file.path) !==
								fileContents.get(file.path)?.content?.newContent),
				)
			: files;
		return [...filtered].sort((a, b) => comparePaths(a.path, b.path));
	}, [files, reviewState, hideReviewed, optimisticBaselines, fileContents]);

	const markRangeReviewed = rangeReview.markRangeReviewed;
	const markSelectionReviewed = useCallback(
		(path: string, range: HeadRange) =>
			markRangeReviewed(path, range, fileContents.get(path)?.content),
		[markRangeReviewed, fileContents],
	);

	return {
		fileContents,
		forcedPaths,
		addForcedPath,
		optimisticBaselines: rangeReview.optimisticBaselines,
		visibleFiles,
		allFilesReviewed: files.length > 0 && visibleFiles.length === 0,
		viewedCount,
		handleRenderedPathsChange,
		markSelectionReviewed,
		setRangeViewed: rangeReview.setRangeViewed,
		undoStack: rangeReview.undoStack,
	};
}

/**
 * Ticking a line range Reviewed, as a selection claim: the one path both
 * Files Changed's selection popover and the Guide's hunk rows go through, so
 * the optimistic baseline and the undo record are built the same way. `content`
 * is the file's loaded contents; without them the tick still lands, just
 * without the optimistic baseline. `claimId` is for a caller that must find the
 * claim again to withdraw it; a selection's is random.
 */
export function useRangeReview(
	orpc: SidecarQueryUtils,
	sessionId: string,
	files: readonly FileChange[],
) {
	const optimisticBaselines = useOptimisticRangeBaselines(orpc, sessionId);
	// Lives in the per-session store, not here: it's not reactive (nothing
	// renders off it), just addressable by session id so it survives the
	// owning component unmounting on tab suspend, and every pane feeds one stack.
	const undoStack = useSessionUndoStack(sessionId);
	const setRangeViewed = useSetRangeViewed(orpc, sessionId);
	const markRangeReviewed = useCallback(
		(
			path: string,
			range: HeadRange,
			content: FileContent | undefined,
			claimId?: string,
		) => {
			const baselineBefore =
				optimisticBaselines.get(path) ??
				content?.oldContent ??
				(files.some((file) => file.path === path && file.status === "added")
					? ""
					: undefined);
			const baseline =
				content !== undefined &&
				!content.truncated &&
				content.newContent !== undefined &&
				baselineBefore !== undefined
					? optimisticRangeBaseline(baselineBefore, content.newContent, range)
					: undefined;
			const blockId = claimId ?? `selection:${crypto.randomUUID()}`;
			const blockLabel =
				range.startLine === range.endLine
					? `Selection L${range.startLine}`
					: `Selection L${range.startLine}–L${range.endLine}`;
			setRangeViewed(
				{ path, blockId, blockLabel, ranges: [range], viewed: true },
				() => {
					undoStack.push({
						kind: "range",
						path,
						blockId,
						blockLabel,
						range,
						baselineBefore,
					});
				},
				baseline,
			);
		},
		[setRangeViewed, undoStack, optimisticBaselines, files],
	);
	return { optimisticBaselines, setRangeViewed, undoStack, markRangeReviewed };
}
