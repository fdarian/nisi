"use client";

import { MoreHorizontalIcon, StarIcon } from "lucide-react";
import { useState } from "react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import type { PullRequestInfo } from "#/lib/pr-data";
import { cn } from "#/lib/utils";

type PrHeaderProps = {
	pr: PullRequestInfo;
	stat: { additions: number; deletions: number };
	onCloseTab: () => void;
};

/** Keep it quiet — the diff is the subject. */
export function PrHeader({
	pr,
	stat,
	onCloseTab,
}: PrHeaderProps): React.ReactElement {
	const [starred, setStarred] = useState(false);

	return (
		<div className="flex items-center gap-3 border-b px-4 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Breadcrumb>
					<BreadcrumbList className="text-xs">
						<BreadcrumbItem>
							{pr.owner}/{pr.repo}
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-muted-foreground">
								#{pr.number}
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<div className="flex min-w-0 items-baseline gap-2">
					<h1 className="truncate font-heading font-semibold text-base">
						{pr.title}
					</h1>
					<span className="shrink-0 font-mono text-xs tabular-nums">
						<span className="text-success-foreground">+{stat.additions}</span>{" "}
						<span className="text-destructive-foreground">
							-{stat.deletions}
						</span>
					</span>
				</div>
			</div>
			<Button
				aria-label={starred ? "Unstar pull request" : "Star pull request"}
				aria-pressed={starred}
				onClick={() => setStarred((current) => !current)}
				size="icon-sm"
				variant="ghost"
			>
				<StarIcon className={cn(starred && "fill-current text-warning")} />
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger
					aria-label="More actions"
					className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onClick={onCloseTab}>Close tab</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
