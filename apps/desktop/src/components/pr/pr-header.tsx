"use client";

import { invoke } from "@tauri-apps/api/core";
import { MoreHorizontalIcon } from "lucide-react";
import { useState } from "react";
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
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { SessionTarget } from "#/lib/pr-data";
import {
	useMarkPullRequestReady,
	usePullRequestMergeStatus,
} from "#/lib/pr-data";
import { cn } from "#/lib/utils";
import { PrMergeButton } from "./pr-merge-button";

type PrHeaderProps = {
	orpc: SidecarQueryUtils;
	target: SessionTarget;
	repoRoot: string;
	stat: { additions: number; deletions: number };
	onCloseTab: () => void;
};

/** An editor with a URL scheme registered in macOS Launch Services — see `editors.rs`'s `list_available_editors`. */
type EditorInfo = {
	id: string;
	name: string;
};

/**
 * Opens `repoRoot` in the editor registered for `scheme` — repo-root only,
 * no file/line targeting. Surfaces a failed `open_in_editor` invoke as a
 * toast rather than swallowing it, matching how failed refetches are
 * surfaced elsewhere (`use-refetch-toasts.ts`).
 */
function openInEditor(
	scheme: string,
	editorName: string,
	repoRoot: string,
): void {
	invoke("open_in_editor", { scheme, path: repoRoot }).catch(
		(error: unknown) => {
			toastManager.add({
				title: `Failed to open in ${editorName}`,
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	);
}

type MarkReadyMenuItemProps = {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
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
}: MarkReadyMenuItemProps): React.ReactElement | null {
	const statusQuery = usePullRequestMergeStatus(orpc, {
		repoRoot,
		owner,
		repo,
		number,
	});
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
}: PrHeaderProps): React.ReactElement {
	const repoNameSegments = repoRoot.split("/");
	const repoName = repoNameSegments[repoNameSegments.length - 1] || repoRoot;
	const [editors, setEditors] = useState<EditorInfo[]>([]);

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
			{target.kind === "pr" && (
				<PrMergeButton
					number={target.number}
					orpc={orpc}
					owner={target.owner}
					repo={target.repo}
					repoRoot={repoRoot}
				/>
			)}
			<DropdownMenu
				onOpenChange={(open) => {
					if (!open) return;
					invoke<EditorInfo[]>("list_available_editors")
						.then(setEditors)
						.catch((error: unknown) => {
							toastManager.add({
								title: "Failed to list available editors",
								description:
									error instanceof Error ? error.message : String(error),
								type: "error",
							});
						});
				}}
			>
				<DropdownMenuTrigger
					aria-label="More actions"
					className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
				>
					<MoreHorizontalIcon />
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					{target.kind === "pr" && (
						<MarkReadyMenuItem
							number={target.number}
							orpc={orpc}
							owner={target.owner}
							repo={target.repo}
							repoRoot={repoRoot}
						/>
					)}
					<DropdownMenuItem onClick={onCloseTab}>Close tab</DropdownMenuItem>
					{editors.length > 0 && (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>Open in...</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{editors.map((editor) => (
									<DropdownMenuItem
										key={editor.id}
										onClick={() =>
											openInEditor(editor.id, editor.name, repoRoot)
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
