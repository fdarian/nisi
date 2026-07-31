"use client";

import { AlertTriangleIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { FilesChangedView } from "#/components/pr/files-changed-view";
import { PrHeader } from "#/components/pr/pr-header";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { WalkthroughView } from "#/components/walkthrough/walkthrough-view";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { Session } from "#/lib/pr-data";
import {
	useFileChanges,
	useLiveFileChanges,
	useReviewState,
	useSetFileViewed,
} from "#/lib/pr-data";

type PrViewProps = {
	session: Session;
	orpc: SidecarQueryUtils;
	onCloseTab: () => void;
};

/** Renders one open PR's content: header + Files Changed / Walkthrough / Commits tabs. */
export function PrView({
	session,
	orpc,
	onCloseTab,
}: PrViewProps): React.ReactElement {
	const { files, isLoading, error } = useFileChanges(orpc, session.id);
	const reviewState = useReviewState(orpc, files);
	const setViewed = useSetFileViewed(orpc, session.id);
	useLiveFileChanges(orpc, session.id);

	// Lifted above both tabs' content — a "reviewed in `<block>`" marker
	// clicked from Files Changed needs to both select a block in the
	// Walkthrough tab and switch to it, and `Tabs` here is the one thing both
	// live under.
	const [activeTab, setActiveTab] = useState("files");
	const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
	const handleNavigateToBlock = useCallback((blockId: string) => {
		setSelectedBlockId(blockId);
		setActiveTab("walkthrough");
	}, []);

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

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PrHeader
				onCloseTab={onCloseTab}
				pr={session.pr}
				repoRoot={session.repoRoot}
				stat={stat}
			/>
			<Tabs
				className="flex min-h-0 flex-1 flex-col gap-0"
				onValueChange={(value) => setActiveTab(value as string)}
				value={activeTab}
			>
				<div className="border-b">
					<TabsList className="mx-4" variant="underline">
						<TabsTrigger value="walkthrough">Walkthrough</TabsTrigger>
						<TabsTrigger value="files">Files Changed</TabsTrigger>
					</TabsList>
				</div>

				<TabsContent className="flex min-h-0 flex-1 flex-col" value="files">
					{error != null ? (
						<FilesChangedError error={error} />
					) : isLoading ? (
						<FilesChangedLoading />
					) : (
						<FilesChangedView
							files={files}
							onNavigateToBlock={handleNavigateToBlock}
							orpc={orpc}
							reviewState={reviewState}
							session={session}
							setViewed={setViewed}
						/>
					)}
				</TabsContent>
				<TabsContent className="flex min-h-0 flex-1" value="walkthrough">
					<WalkthroughView
						files={files}
						onSelectBlock={setSelectedBlockId}
						orpc={orpc}
						selectedBlockId={selectedBlockId}
						session={session}
					/>
				</TabsContent>
			</Tabs>
		</div>
	);
}

function FilesChangedLoading(): React.ReactElement {
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<Spinner className="size-5" />
			</EmptyMedia>
			<EmptyTitle>Loading changed files…</EmptyTitle>
		</Empty>
	);
}

function FilesChangedError({ error }: { error: unknown }): React.ReactElement {
	const message = error instanceof Error ? error.message : String(error);
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<AlertTriangleIcon />
			</EmptyMedia>
			<EmptyTitle>Couldn't load changed files</EmptyTitle>
			<EmptyDescription>{message}</EmptyDescription>
		</Empty>
	);
}
