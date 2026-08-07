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
import type { SessionTarget } from "#/lib/pr-data";
import { cn } from "#/lib/utils";

type PrHeaderProps = {
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

/** Keep it quiet — the diff is the subject. */
export function PrHeader({
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
