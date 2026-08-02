"use client";

import { MoreHorizontalIcon } from "lucide-react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { buttonVariants } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import type { SessionTarget } from "#/lib/pr-data";
import { cn } from "#/lib/utils";

type PrHeaderProps = {
	target: SessionTarget;
	repoRoot: string;
	stat: { additions: number; deletions: number };
	onCloseTab: () => void;
};

/** Keep it quiet — the diff is the subject. */
export function PrHeader({
	target,
	repoRoot,
	stat,
	onCloseTab,
}: PrHeaderProps): React.ReactElement {
	const repoNameSegments = repoRoot.split("/");
	const repoName = repoNameSegments[repoNameSegments.length - 1] || repoRoot;

	return (
		<div className="flex items-center gap-3 border-b px-4 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Breadcrumb>
					<BreadcrumbList className="text-xs">
						<BreadcrumbItem>
							{target.kind === "pr"
								? `${target.owner}/${target.repo}`
								: repoName}
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-muted-foreground">
								{target.kind === "pr" ? (
									`#${target.number}`
								) : (
									<>
										vs <span className="font-mono">{target.baseRef}</span>
									</>
								)}
							</BreadcrumbPage>
						</BreadcrumbItem>
					</BreadcrumbList>
				</Breadcrumb>
				<div className="flex min-w-0 items-baseline gap-2">
					<h1 className="truncate font-heading font-semibold text-base">
						{target.kind === "pr" ? target.title : target.headRef}
					</h1>
					<span className="shrink-0 font-mono text-xs tabular-nums">
						<span className="text-success-foreground">+{stat.additions}</span>{" "}
						<span className="text-destructive-foreground">
							-{stat.deletions}
						</span>
					</span>
				</div>
			</div>
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
