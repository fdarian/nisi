"use client";

import { useState } from "react";
import { Empty, EmptyMedia, EmptyTitle } from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { GeneratePanel } from "#/components/walkthrough/generate-panel";
import { NarrativePane } from "#/components/walkthrough/narrative-pane";
import { OutdatedBanner } from "#/components/walkthrough/outdated-banner";
import { ReferencePane } from "#/components/walkthrough/reference-pane";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileChange, Session } from "#/lib/pr-data";
import {
	useWalkthrough,
	useWalkthroughDrift,
	useWalkthroughGeneration,
} from "#/lib/walkthrough-data";

type WalkthroughViewProps = {
	orpc: SidecarQueryUtils;
	session: Session;
	files: readonly FileChange[];
};

/**
 * The Walkthrough tab's top-level state machine: loading → generate panel
 * (nothing stored yet, or a generation is streaming) → two-pane reader
 * (narrative left, reference block right) once `walkthrough.get` has
 * something. `useWalkthroughGeneration` writes a successful `done` straight
 * into the `walkthrough.get` cache, so finishing a generation flips this
 * over to the reader without an extra round trip.
 */
export function WalkthroughView({
	orpc,
	session,
	files,
}: WalkthroughViewProps): React.ReactElement {
	const { walkthrough, isLoading } = useWalkthrough(orpc, session.id);
	const generation = useWalkthroughGeneration(orpc, session.id);
	const drift = useWalkthroughDrift(walkthrough, files);
	const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);

	if (isLoading) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<Spinner className="size-5" />
				</EmptyMedia>
				<EmptyTitle>Loading walkthrough…</EmptyTitle>
			</Empty>
		);
	}

	if (generation.progress.phase === "running" || walkthrough == null) {
		return (
			<GeneratePanel
				history={generation.history}
				onGenerate={generation.generate}
				orpc={orpc}
				progress={generation.progress}
			/>
		);
	}

	const knownBlockIds = new Set(
		walkthrough.walkthrough.references.map((block) => block.id),
	);
	const selectedBlock =
		walkthrough.walkthrough.references.find(
			(block) => block.id === selectedBlockId,
		) ?? null;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{generation.progress.phase === "failed" && (
				<div className="shrink-0 border-b bg-destructive/8 px-4 py-2 text-destructive-foreground text-xs dark:bg-destructive/16">
					Regeneration failed: {generation.progress.message}
				</div>
			)}
			<OutdatedBanner
				changedPaths={drift.changedPaths}
				onRegenerate={() =>
					generation.generate(
						walkthrough.harness,
						walkthrough.model ?? undefined,
					)
				}
			/>
			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col border-r">
					<NarrativePane
						knownBlockIds={knownBlockIds}
						onSelectBlock={setSelectedBlockId}
						outdatedBlockIds={drift.outdatedBlockIds}
						sections={walkthrough.walkthrough.sections}
						selectedBlockId={selectedBlockId}
					/>
				</div>
				<div className="flex min-h-0 w-[42%] max-w-2xl flex-col">
					<ReferencePane
						block={selectedBlock}
						changedPaths={drift.changedPaths}
						files={files}
						orpc={orpc}
						sessionId={session.id}
					/>
				</div>
			</div>
		</div>
	);
}
