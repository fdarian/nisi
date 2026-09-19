"use client";

import { MoreHorizontalIcon } from "lucide-react";
import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";
import { Button } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import {
	openInEditor,
	useAvailableEditors,
} from "#/hooks/use-available-editors";
import { useDismissOnInactive } from "./use-dismiss-on-inactive";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { SessionTarget } from "#/lib/pr-data";
import {
	useMarkPullRequestReady,
	usePullRequestMergeStatus,
} from "#/lib/pr-data";
import type { OpenPullRequestParams } from "#/lib/pull-requests-data";
import { PrCiStatus } from "./pr-ci-status";
import { PrMergeButton } from "./pr-merge-button";
import { PrStackBadge } from "./pr-stack-badge";

type PrHeaderProps = {
	orpc: SidecarQueryUtils;
	target: SessionTarget;
	repoRoot: string;
	stat: { additions: number; deletions: number };
	onCloseTab: () => void;
	/** This PR's tab is both the selected one and the window has focus — threaded straight through to `PrCiStatus`'s own poll gating, see `usePullRequestChecks` (`pr-data.ts`). */
	watched: boolean;
	/** This PR's session id — threaded straight through to `PrCiStatus`, see `usePullRequestChecks`'s `useAwaitingNewCi` (`pr-data.ts`). */
	sessionId: string;
	findExistingSessionId: (params: OpenPullRequestParams) => string | undefined;
	onSessionOpened: (sessionId: string) => void;
};

type MarkReadyMenuItemProps = {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
	/** This PR's tab is both the selected one and the window has focus — see `usePullRequestMergeStatus` (`pr-data.ts`). */
	watched: boolean;
};

/**
 * Only mounted when the parent already knows `target.kind === "pr"` (see
 * `PrHeader` below) — that's what lets it call `usePullRequestMergeStatus`
 * unconditionally despite the hook needing `owner`/`repo`/`number`, which a
 * branch session doesn't have. Reads the exact same query `PrMergeButton`
 * already polls (shared cache, no extra round trip), so draftness has one
 * source of truth, and renders nothing until that query actually confirms
 * the PR is a draft.
 */
function MarkReadyMenuItem({
	orpc,
	repoRoot,
	owner,
	repo,
	number,
	watched,
}: MarkReadyMenuItemProps): React.ReactElement | null {
	const statusQuery = usePullRequestMergeStatus(
		orpc,
		{ repoRoot, owner, repo, number },
		watched,
	);
	const { markReady, isPending } = useMarkPullRequestReady(orpc);

	if (statusQuery.data?.isDraft !== true) return null;

	return (
		<DropdownMenuItem
			disabled={isPending}
			onClick={() => markReady({ repoRoot, owner, repo, number })}
		>
			Mark as Ready
		</DropdownMenuItem>
	);
}

/** Keep it quiet — the diff is the subject. */
export function PrHeader({
	orpc,
	target,
	repoRoot,
	stat,
	onCloseTab,
	watched,
	sessionId,
	findExistingSessionId,
	onSessionOpened,
}: PrHeaderProps): React.ReactElement {
	const repoNameSegments = repoRoot.split("/");
	const repoName = repoNameSegments[repoNameSegments.length - 1] || repoRoot;
	const { editors, loadEditors } = useAvailableEditors();
	const [overflowMenuOpen, setOverflowMenuOpen] = useDismissOnInactive(watched);

	return (
		<div className="flex items-center gap-3 border-b pl-4 pr-6 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Breadcrumb>
					<BreadcrumbList className="text-xs h-6">
						<BreadcrumbItem>
							{target.kind === "pr"
								? `${target.owner}/${target.repo}`
								: repoName}
						</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-muted-foreground">
								{target.kind === "pr" ? (
									<div className="flex items-center gap-1.5">
										<span>#{target.number}</span>
										<PrStackBadge
											number={target.number}
											orpc={orpc}
											owner={target.owner}
											repo={target.repo}
											watched={watched}
											findExistingSessionId={findExistingSessionId}
											onSessionOpened={onSessionOpened}
										/>
									</div>
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
			{target.kind === "pr" && (
				<div className="flex items-center gap-1">
					<PrCiStatus
						number={target.number}
						orpc={orpc}
						owner={target.owner}
						repo={target.repo}
						repoRoot={repoRoot}
						sessionId={sessionId}
						watched={watched}
					/>
					<PrMergeButton
						number={target.number}
						orpc={orpc}
						owner={target.owner}
						repo={target.repo}
						repoRoot={repoRoot}
						watched={watched}
					/>
				</div>
			)}
			<DropdownMenu
				onOpenChange={(open) => {
					setOverflowMenuOpen(open);
					if (open) loadEditors();
				}}
				open={overflowMenuOpen}
			>
				<DropdownMenuTrigger
					aria-label="More actions"
					render={(props) => (
						<Button variant="ghost" size="icon-sm" {...props}>
							<MoreHorizontalIcon />
						</Button>
					)}
				/>

				<DropdownMenuContent align="end">
					{target.kind === "pr" && (
						<MarkReadyMenuItem
							number={target.number}
							orpc={orpc}
							owner={target.owner}
							repo={target.repo}
							repoRoot={repoRoot}
							watched={watched}
						/>
					)}
					<DropdownMenuItem onClick={onCloseTab}>Close tab</DropdownMenuItem>
					<DropdownMenuItem
						onClick={() => navigator.clipboard.writeText(target.headRef)}
					>
						Copy branch name
					</DropdownMenuItem>
					{editors.length > 0 && (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Open in...</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{editors.map((editor) => (
									<DropdownMenuItem
										key={editor.id}
										onClick={() =>
											openInEditor(editor.id, editor.name, repoRoot, repoRoot)
										}
									>
										{editor.name}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					)}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
