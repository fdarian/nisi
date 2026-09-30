"use client";

import { ClockFading, X } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTitle,
	PopoverTrigger,
} from "#/components/ui/popover";
import { toastManager } from "#/components/ui/toast";
import {
	type MergeMethod,
	useAutoMerge,
	usePullRequestMergeStatus,
} from "#/features/pull-request/data/pr-data";
import { useDismissOnInactive } from "#/features/pull-request/use-dismiss-on-inactive";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import {
	MergeErrorDialog,
	type MergeFailure,
	mergeFailureMessage,
} from "./merge-error-dialog";

const METHOD_DESCRIPTION: Record<MergeMethod, string> = {
	merge: "merge commit",
	squash: "squash and merge",
	rebase: "rebase and merge",
};

export function PrAutoMergeIndicator(props: {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	watched: boolean;
	isSelectedTab: boolean;
}): React.ReactElement | null {
	const params = {
		repoRoot: props.repoRoot,
		owner: props.owner,
		repo: props.repo,
		number: props.number,
	};
	const status = usePullRequestMergeStatus(
		props.orpc,
		params,
		props.isSelectedTab,
	);
	const popup = useDismissOnInactive(props.watched);
	const failureState = useState<MergeFailure | null>(null);
	const autoMerge = useAutoMerge(props.orpc, (error, input) => {
		const failure = {
			title: `Couldn't cancel auto-merge for #${input.number}`,
			...mergeFailureMessage(error),
		};
		toastManager.add({
			title: failure.title,
			description: failure.reason,
			type: "error",
			actionProps: {
				children: "View details",
				onClick: () => failureState[1](failure),
			},
		});
	});
	const request = status.data?.autoMerge;
	if (request === undefined || request === null) return null;

	return (
		<>
			<span aria-hidden="true" className="h-px w-3 shrink-0 bg-border" />
			<Popover open={popup[0]} onOpenChange={popup[1]}>
				<PopoverTrigger
					aria-label="Auto-merge scheduled"
					className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent data-popup-open:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1"
				>
					<ClockFading className="size-4" />
				</PopoverTrigger>
				<PopoverPopup
					align="end"
					className="w-80"
					viewportClassName="py-1 [--viewport-inline-padding:--spacing(1)]"
				>
					<PopoverTitle className="px-2 pt-2 font-medium text-sm">
						Auto-merge scheduled
					</PopoverTitle>
					<PopoverDescription className="px-2 py-1.5 text-xs">
						Scheduled to auto-merge using {METHOD_DESCRIPTION[request.method]}{" "}
						once CI checks pass.
					</PopoverDescription>
					<div className="mx-2 my-1 h-px bg-border" />
					<div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
						Actions
					</div>
					<Button
						variant="ghost"
						size="sm"
						className="w-full justify-start font-normal"
						disabled={autoMerge.isPending}
						onClick={() => autoMerge.disable(params)}
					>
						<X />
						Cancel auto-merge
					</Button>
				</PopoverPopup>
			</Popover>
			<span aria-hidden="true" className="h-px w-3 shrink-0 bg-border" />
			<MergeErrorDialog
				failure={failureState[0]}
				onOpenChange={(open) => {
					if (!open) failureState[1](null);
				}}
			/>
		</>
	);
}
