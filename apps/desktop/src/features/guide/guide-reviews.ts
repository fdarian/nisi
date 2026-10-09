import { useCallback, useMemo } from "react";
import { claimsOverlapping } from "#/features/diff/review-coverage";
import type { LineRange } from "#/features/diff/viewer/build-location-diff";
import type {
	FileChange,
	FileContent,
	FileContentsMap,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import { useFileContents } from "#/features/pull-request/data/pr-data";
import { useRangeReview } from "#/features/pull-request/files/diff-pane/use-diff-pane-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";

/**
 * The review state and setters an Area's rows tick: the same sources Files
 * Changed reads (`reviewState`, `setViewed`, and `useRangeReview`'s selection
 * claim), so a tick here shows in Files Changed and the other way round. Absent
 * from the static preview, which has no review state to show.
 */
export type GuideReviews = {
	fileViewed: (path: string) => boolean;
	setFileViewed: (path: string, viewed: boolean) => void;
	/** A hook, because the contents behind a hunk row's state are only fetched for the rows an open Area actually lists. */
	useFileReviews: (paths: readonly string[]) => FileContentsMap;
	setHunkViewed: (
		path: string,
		range: LineRange,
		content: FileContent | undefined,
		viewed: boolean,
	) => void;
};

const NO_FORCED_PATHS: ReadonlySet<string> = new Set();

export function useGuideReviews(params: {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	setViewed: (path: string, viewed: boolean) => void;
}): GuideReviews {
	const orpc = params.orpc;
	const sessionId = params.sessionId;
	const reviewState = params.reviewState;
	const rangeReview = useRangeReview(orpc, sessionId, params.files);
	const markRangeReviewed = rangeReview.markRangeReviewed;
	const setRangeViewed = rangeReview.setRangeViewed;
	const setViewed = params.setViewed;

	const fileViewed = useCallback(
		(path: string) => reviewState.get(path)?.status === "viewed",
		[reviewState],
	);
	const useFileReviews = useCallback(
		(paths: readonly string[]) =>
			// biome-ignore lint/correctness/useHookAtTopLevel: invoked at the top level of the component that receives it through context
			useFileContents(orpc, sessionId, paths, NO_FORCED_PATHS, "all"),
		[orpc, sessionId],
	);
	const setHunkViewed = useCallback(
		(
			path: string,
			range: LineRange,
			content: FileContent | undefined,
			viewed: boolean,
		) => {
			if (viewed) {
				markRangeReviewed(path, range, content);
				return;
			}
			const claims = claimsOverlapping(range, content?.review);
			// The hunk is reviewed only because the whole file is: that claim is
			// the only one there is to withdraw.
			if (claims.wholeFile) setViewed(path, false);
			for (const block of claims.blocks) {
				setRangeViewed({
					path,
					blockId: block.blockId,
					blockLabel: block.blockLabel,
					ranges: [range],
					viewed: false,
				});
			}
		},
		[markRangeReviewed, setRangeViewed, setViewed],
	);

	return useMemo(
		() => ({
			fileViewed,
			setFileViewed: setViewed,
			useFileReviews,
			setHunkViewed,
		}),
		[fileViewed, setViewed, useFileReviews, setHunkViewed],
	);
}
