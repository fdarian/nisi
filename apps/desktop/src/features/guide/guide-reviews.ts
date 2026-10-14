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
import { hunkClaimBlockId, hunkClaimRange } from "./areas";

/**
 * The review state and setters an Area's rows tick: the same sources Files
 * Changed reads (`reviewState`, `setViewed`, and `useRangeReview`'s selection
 * claim), so a tick here shows in Files Changed and the other way round. Absent
 * from the static preview, which has no review state to show.
 */
export type GuideReviews = {
	fileViewed: (path: string) => boolean;
	setFileViewed: (path: string, viewed: boolean) => void;
	/** A hook, because the contents behind a hunk row's state are only fetched while an Area is open. */
	useFileReviews: (paths: readonly string[]) => FileContentsMap;
	/** All of one file's hunks in one call, so their optimistic baselines build on each other instead of each replacing the last. */
	setHunksViewed: (
		path: string,
		hunks: readonly ClaimedHunk[],
		content: FileContent | undefined,
		viewed: boolean,
	) => void;
};

export type ClaimedHunk = { range: LineRange; deletions: number };

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
	const markRangesReviewed = rangeReview.markRangesReviewed;
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
	const setHunksViewed = useCallback(
		(
			path: string,
			hunks: readonly ClaimedHunk[],
			content: FileContent | undefined,
			viewed: boolean,
		) => {
			if (viewed) {
				markRangesReviewed(
					path,
					hunks.map((hunk) => ({
						range: hunkClaimRange(hunk.range, hunk.deletions),
						claimId: hunkClaimBlockId(path, hunk.range),
					})),
					content,
				);
				return;
			}
			const claims = hunks.map((hunk) => ({
				range: hunk.range,
				overlapping: claimsOverlapping(hunk.range, content?.review),
			}));
			// A hunk reviewed only because the whole file is: that claim is the
			// only one there is to withdraw.
			if (
				fileViewed(path) ||
				claims.some((claim) => claim.overlapping.wholeFile)
			)
				setViewed(path, false);
			for (const claim of claims) {
				// A removed line has no reviewed range to name its claim, so the tick's
				// own claim is withdrawn by the id it was written under.
				const blocks = new Map(
					claim.overlapping.blocks.map((block) => [
						block.blockId,
						block.blockLabel,
					]),
				);
				blocks.set(hunkClaimBlockId(path, claim.range), "Hunk");
				for (const [blockId, blockLabel] of blocks) {
					setRangeViewed({
						path,
						blockId,
						blockLabel,
						ranges: [claim.range],
						viewed: false,
					});
				}
			}
		},
		[markRangesReviewed, setRangeViewed, setViewed, fileViewed],
	);

	return useMemo(
		() => ({
			fileViewed,
			setFileViewed: setViewed,
			useFileReviews,
			setHunksViewed,
		}),
		[fileViewed, setViewed, useFileReviews, setHunksViewed],
	);
}
