import { MoreHorizontalIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Skeleton } from "#/components/ui/skeleton";
import { PrMergeButtonSkeleton } from "../merge/pr-merge-button";
import { CiStatusSkeleton } from "./ci-status";
import { PrDiffStat } from "./pr-diff-stat";
import { PrHeaderShell } from "./pr-header-shell";

type PrHeaderSkeletonProps = {
	/** What a deep link already says about the PR; absent when the open request carries nothing yet. */
	pullRequest?: { owner: string; repo: string; number: number };
};

/**
 * `PrHeader`'s stand-in while a PR is still opening: text for whatever the
 * open request already knows, skeleton bars for the rest, in the same
 * `PrHeaderShell` so the real header lands without moving anything.
 */
export function PrHeaderSkeleton(
	props: PrHeaderSkeletonProps,
): React.ReactElement {
	const pullRequest = props.pullRequest;
	return (
		<div className="motion-reduce:[&_[data-slot=skeleton]]:animate-none">
			<PrHeaderShell
				repo={
					pullRequest === undefined ? (
						<Skeleton className="h-2 w-28" />
					) : (
						`${pullRequest.owner}/${pullRequest.repo}`
					)
				}
				refLabel={
					pullRequest === undefined ? (
						<Skeleton className="h-2 w-10" />
					) : (
						`#${pullRequest.number}`
					)
				}
				title={<Skeleton className="inline-block h-3.5 w-72 align-middle" />}
				stat={<PrDiffStat stat={{ status: "loading" }} />}
				actions={
					pullRequest === undefined ? undefined : (
						<>
							<CiStatusSkeleton />
							<PrMergeButtonSkeleton />
						</>
					)
				}
				menu={
					<Button
						aria-label="More actions"
						disabled
						size="icon-sm"
						variant="ghost"
					>
						<MoreHorizontalIcon />
					</Button>
				}
			/>
		</div>
	);
}
