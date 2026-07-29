"use client";

import { Link } from "@tanstack/react-router";
import { SparklesIcon } from "lucide-react";
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
	useHarnesses,
} from "#/lib/walkthrough-data";

type GeneratePanelProps = {
	orpc: SidecarQueryUtils;
	progress: GenerationProgress;
	history: readonly GenerationLogEntry[];
	onGenerate: (harness: HarnessId, model: string | undefined) => void;
};

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
}: GeneratePanelProps): React.ReactElement {
	const { harnesses } = useHarnesses(orpc);
	const { settings } = useSettings(orpc);
	const updateSettings = useUpdateSettings(orpc);
	const [selection, setSelection] = useState<ModelSelection | null>(null);
	const [reconfiguring, setReconfiguring] = useState(false);

	if (progress.phase === "running") {
		return (
			<div className="flex flex-1 items-center justify-center px-6">
				<GenerationTimeline history={history} />
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
			<div className="flex items-center gap-2">
				<HarnessModelCombobox
					harnesses={harnesses}
					onChange={setSelection}
					value={selection}
				/>
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
