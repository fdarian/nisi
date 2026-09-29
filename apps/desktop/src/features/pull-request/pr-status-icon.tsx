import { cn } from "cn";
import {
	GitMergeIcon,
	GitMergeConflictIcon,
	GitPullRequestArrowIcon,
	GitPullRequestDraftIcon,
} from "lucide-react";
import type { PrStatus } from "./pr-status";

export function PrStatusIcon({
	status,
	className,
}: {
	status: PrStatus;
	className?: string;
}): React.ReactElement {
	const iconClass = cn("size-3.5 shrink-0", className);
	switch (status) {
		case "merged":
			return <GitMergeIcon className={cn(iconClass, "text-merged")} />;
		case "conflicts":
			return (
				<GitMergeConflictIcon className={cn(iconClass, "text-destructive")} />
			);
		case "draft":
			return (
				<GitPullRequestDraftIcon
					className={cn(iconClass, "text-muted-foreground")}
				/>
			);
		case "ci-running":
			return (
				<GitPullRequestArrowIcon
					className={cn(iconClass, "animate-pulse text-warning")}
				/>
			);
		case "ready":
			return (
				<GitPullRequestArrowIcon className={cn(iconClass, "text-success")} />
			);
		case "default":
			return <GitPullRequestArrowIcon className={iconClass} />;
	}
}
