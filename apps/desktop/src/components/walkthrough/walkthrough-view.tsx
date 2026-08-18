"use client";

import { Empty, EmptyMedia, EmptyTitle } from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import { GeneratePanel } from "#/components/walkthrough/generate-panel";
import { NarrativePane } from "#/components/walkthrough/narrative-pane";
import { OutdatedBanner } from "#/components/walkthrough/outdated-banner";
import { ReferencePane } from "#/components/walkthrough/reference-pane";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileChange, Session } from "#/lib/pr-data";
import type {
	UncoveredFile,
	WalkthroughReferenceBlock,
	Walkthrough as WalkthroughSchema,
	WalkthroughSelection,
} from "#/lib/walkthrough-data";
import {
	useWalkthrough,
	useWalkthroughDrift,
	useWalkthroughGeneration,
} from "#/lib/walkthrough-data";

type WalkthroughViewProps = {
	orpc: SidecarQueryUtils;
	session: Session;
	files: readonly FileChange[];
	/** Lifted to `PrView` rather than local state, so it survives switching away to Files Changed and back. */
	selection: WalkthroughSelection | null;
	onSelectionChange: (selection: WalkthroughSelection) => void;
};

/**
 * Resolves the reference pane's selection into the `{id, label, locations}`
 * shape it renders, whichever kind of thing is selected. A `"reference"`
 * selection looks up a real, agent-authored block. An `"uncovered"`
 * selection has no such block to look up — nothing in
 * `walkthrough.references` claims that file — so this builds one locally,
 * scoped to just that file's skipped ranges, rather than minting a fake
 * entry inside `walkthrough.references` itself (which would misrepresent it
 * as something the agent actually narrated). The `uncovered:` id prefix
 * keeps it from ever colliding with a real reference id.
 */
function resolveSelection(
	selection: WalkthroughSelection | null,
	walkthrough: WalkthroughSchema,
	uncoveredFiles: readonly UncoveredFile[] | undefined,
): WalkthroughReferenceBlock | null {
	if (selection === null) return null;

	if (selection.kind === "reference") {
		return (
			walkthrough.references.find((block) => block.id === selection.id) ?? null
		);
	}

	const file = uncoveredFiles?.find((entry) => entry.path === selection.path);
	if (file === undefined) return null;
	return {
		id: `uncovered:${file.path}`,
		label: "Not covered by this walkthrough",
		locations: file.ranges.map((range) => ({
			path: file.path,
			startLine: range.start,
			endLine: range.end,
		})),
	};
}

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
	selection,
	onSelectionChange,
}: WalkthroughViewProps): React.ReactElement {
	const { walkthrough, isLoading } = useWalkthrough(orpc, session.id);
	const generation = useWalkthroughGeneration(orpc, session.id);
	const drift = useWalkthroughDrift(walkthrough, files);

	// `generation.isReattaching` covers the gap between mounting (a tab
	// switch back to Walkthrough, e.g.) and finding out whether a generation
	// is already streaming server-side for this session — without this, a
	// remount during a still-running Generate/Regenerate would render the
	// stale stored walkthrough for a beat before flipping over to the resumed
	// progress timeline. See `useWalkthroughGeneration`'s doc comment.
	if (isLoading || generation.isReattaching) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<Spinner className="size-5" />
				</EmptyMedia>
				<EmptyTitle>Loading walkthrough…</EmptyTitle>
			</Empty>
		);
	}

	// `"starting"` hands over to `GeneratePanel` on the same commit as the
	// click, so a Generate/Regenerate shows its pending timeline immediately
	// instead of sitting on this reader (or the untouched empty state) until
	// the sidecar's first event lands seconds later.
	if (
		generation.progress.phase === "starting" ||
		generation.progress.phase === "running" ||
		walkthrough == null
	) {
		return (
			<GeneratePanel
				history={generation.history}
				isStopping={generation.isStopping}
				onGenerate={generation.generate}
				onStop={generation.stop}
				orpc={orpc}
				progress={generation.progress}
			/>
		);
	}

	const knownBlockIds = new Set(
		walkthrough.walkthrough.references.map((block) => block.id),
	);
	const resolvedBlock = resolveSelection(
		selection,
		walkthrough.walkthrough,
		walkthrough.uncoveredFiles,
	);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{generation.progress.phase === "failed" && (
				<div className="shrink-0 border-b bg-destructive/8 px-4 py-2 text-destructive-foreground text-xs dark:bg-destructive/16">
					Regeneration failed: {generation.progress.message}
				</div>
			)}
			<OutdatedBanner
				changedPaths={drift.changedPaths}
				defaultHarness={walkthrough.harness}
				defaultModel={walkthrough.model}
				onRegenerate={generation.generate}
				orpc={orpc}
			/>
			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col">
					<NarrativePane
						knownBlockIds={knownBlockIds}
						onSelectionChange={onSelectionChange}
						outdatedBlockIds={drift.outdatedBlockIds}
						sections={walkthrough.walkthrough.sections}
						selection={selection}
						uncoveredFiles={walkthrough.uncoveredFiles}
					/>
				</div>
				<div className="flex min-h-0 w-[42%] max-w-2xl flex-col">
					<ReferencePane
						block={resolvedBlock}
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
