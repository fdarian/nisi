"use client";

import { SparklesIcon } from "lucide-react";
import { useMemo } from "react";
import { FilesChangedView } from "#/components/pr/files-changed-view";
import { PrHeader } from "#/components/pr/pr-header";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import type { Session } from "#/lib/pr-data";
import { useFileChanges, useReviewState } from "#/lib/pr-data";

type PrViewProps = {
	session: Session;
	onCloseTab: () => void;
};

/** Renders one open PR's content: header + Files Changed / Walkthrough / Commits tabs. */
export function PrView({
	session,
	onCloseTab,
}: PrViewProps): React.ReactElement {
	const files = useFileChanges(session.id);
	const reviewState = useReviewState(session.id);

	const stat = useMemo(
		() =>
			files.reduce(
				(totals, file) => ({
					additions: totals.additions + file.additions,
					deletions: totals.deletions + file.deletions,
				}),
				{ additions: 0, deletions: 0 },
			),
		[files],
	);

	if (session.pr == null) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
				No pull request for this session — diffing against the default branch
				isn't wired into the UI yet.
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PrHeader onCloseTab={onCloseTab} pr={session.pr} stat={stat} />
			<Tabs className="flex min-h-0 flex-1 flex-col gap-0" defaultValue="files">
				<TabsList className="mx-4 mt-2 self-start" variant="underline">
					<TabsTrigger value="files">Files Changed</TabsTrigger>
					<TabsTrigger value="walkthrough">Walkthrough</TabsTrigger>
					<TabsTrigger disabled value="commits">
						Commits
					</TabsTrigger>
				</TabsList>
				<TabsContent className="flex min-h-0 flex-1 flex-col" value="files">
					<FilesChangedView files={files} reviewState={reviewState} />
				</TabsContent>
				<TabsContent className="flex min-h-0 flex-1" value="walkthrough">
					<WalkthroughEmptyState />
				</TabsContent>
			</Tabs>
		</div>
	);
}

function WalkthroughEmptyState(): React.ReactElement {
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<SparklesIcon />
			</EmptyMedia>
			<EmptyTitle>Walkthrough</EmptyTitle>
			<EmptyDescription>
				The agent-narrated walkthrough arrives in a later phase.
			</EmptyDescription>
		</Empty>
	);
}
