"use client";

import { Link } from "@tanstack/react-router";
import { RefreshCwIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { EnableHarnessesPanel } from "#/components/walkthrough/enable-harnesses-panel";
import { GenerationTimeline } from "#/components/walkthrough/generation-timeline";
import {
	HarnessModelCombobox,
	type ModelSelection,
} from "#/components/walkthrough/harness-model-combobox";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useSettings, useUpdateSettings } from "#/lib/settings-data";
import { cn } from "#/lib/utils";
import {
	type GenerationLogEntry,
	type GenerationProgress,
	type HarnessId,
	type HarnessInfo,
	useHarnesses,
} from "#/lib/walkthrough-data";

type GeneratePanelProps = {
	orpc: SidecarQueryUtils;
	progress: GenerationProgress;
	history: readonly GenerationLogEntry[];
	onGenerate: (harness: HarnessId, model: string | undefined) => void;
	onStop: () => void;
	isStopping: boolean;
};

/** Enabled harnesses whose `modelsStatus` is `"unavailable"` — either the CLI isn't installed (`!harness.available`) or its live discovery has never once succeeded, see `HarnessInfo`'s doc comment. These are the ones worth naming to the user; `"stale"` is quietly using a cached list and isn't worth alarming over. */
function unavailableHarnessLabels(
	harnesses: readonly HarnessInfo[],
): readonly string[] {
	return harnesses
		.filter(
			(harness) => harness.enabled && harness.modelsStatus === "unavailable",
		)
		.map((harness) => harness.label);
}

/** "X", "X and Y", or "X, Y, and Z" — for naming the harnesses discovery couldn't reach without an awkward comma-joined list for the common one/two-item case. */
function formatList(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	if (items.length === 2) return `${items[0]} and ${items[1]}`;
	return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/**
 * The walkthrough tab's content whenever there's no walkthrough to read yet
 * — either nothing's been generated, or a generation is currently running.
 * First use (`settings.enabledHarnesses === null`) asks which harnesses are
 * set up (checkboxes), writing the choice through `settings.update`; once
 * configured, the combobox lists enabled harnesses' models grouped by
 * harness. `[]` (deliberately disabled everything) is a distinct, legitimate
 * configured state — it doesn't re-trigger onboarding, it just has nothing to
 * generate with.
 */
export function GeneratePanel({
	orpc,
	progress,
	history,
	onGenerate,
	onStop,
	isStopping,
}: GeneratePanelProps): React.ReactElement {
	const { harnesses, refresh, isRefreshing } = useHarnesses(orpc);
	const { settings } = useSettings(orpc);
	const updateSettings = useUpdateSettings(orpc);
	const [selection, setSelection] = useState<ModelSelection | null>(null);
	const [reconfiguring, setReconfiguring] = useState(false);

	// The pending window (`"starting"`, no event yet) renders the *same*
	// timeline the stream drives, so the first event just fills in its log
	// rather than swapping one spinner for another.
	if (progress.phase === "starting" || progress.phase === "running") {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
				<GenerationTimeline history={history} />
				<Button
					aria-label="Stop generation"
					loading={isStopping}
					onClick={onStop}
					size="sm"
					title="Stop generation"
					variant="outline"
				>
					Stop
				</Button>
			</div>
		);
	}

	if (settings.enabledHarnesses === null || reconfiguring) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
				<EnableHarnessesPanel
					harnesses={harnesses}
					initialSelected={settings.enabledHarnesses ?? []}
					onConfirm={(selected) => {
						updateSettings({ enabledHarnesses: selected });
						setReconfiguring(false);
					}}
				/>
			</div>
		);
	}

	if (!harnesses.some((harness) => harness.enabled)) {
		return (
			<Empty className="flex-1">
				<EmptyMedia variant="icon">
					<SparklesIcon />
				</EmptyMedia>
				<EmptyTitle>No harnesses enabled</EmptyTitle>
				<EmptyDescription>
					Every harness is currently disabled, so there's nothing to generate a
					walkthrough with. Enable at least one in Settings.
				</EmptyDescription>
				<Link
					className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
					to="/settings"
				>
					Open settings
				</Link>
			</Empty>
		);
	}

	const unavailable = unavailableHarnessLabels(harnesses);
	const hasAnySelectableModel = harnesses.some(
		(harness) => harness.enabled && harness.models.length > 0,
	);
	const unavailableSummary =
		unavailable.length > 0
			? `Couldn't reach ${formatList(unavailable)} — check ${unavailable.length === 1 ? "it's" : "they're"} installed and on your PATH, then hit refresh.`
			: null;

	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<SparklesIcon />
			</EmptyMedia>
			<EmptyTitle>Walkthrough</EmptyTitle>
			<EmptyDescription>
				Generate an agent-narrated walkthrough of this PR — prose with links
				straight to the code backing each claim.
			</EmptyDescription>
			{progress.phase === "failed" && (
				<p className="max-w-sm text-center text-destructive-foreground text-xs">
					{progress.message}
				</p>
			)}
			{unavailableSummary !== null && (
				<p className="max-w-sm text-center text-muted-foreground text-xs">
					{unavailableSummary}
				</p>
			)}
			<div className="flex items-center gap-2">
				<HarnessModelCombobox
					emptyMessage={
						hasAnySelectableModel
							? undefined
							: (unavailableSummary ?? undefined)
					}
					harnesses={harnesses}
					onChange={setSelection}
					value={selection}
				/>
				<Button
					aria-label="Refresh harnesses and models"
					loading={isRefreshing}
					onClick={refresh}
					size="icon"
					title="Re-check installed harnesses and re-fetch their models"
					variant="outline"
				>
					<RefreshCwIcon />
				</Button>
				<Button
					disabled={selection === null}
					onClick={() => {
						if (selection === null) return;
						onGenerate(selection.harness, selection.modelId);
					}}
				>
					Generate
				</Button>
			</div>
			<Button onClick={() => setReconfiguring(true)} size="sm" variant="ghost">
				Configure harnesses
			</Button>
		</Empty>
	);
}
