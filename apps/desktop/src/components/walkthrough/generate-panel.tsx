"use client";

import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "#/components/ui/button";
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
import { useEnabledHarnesses } from "#/hooks/use-enabled-harnesses";
import type { SidecarQueryUtils } from "#/lib/backend-context";
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
 * First use asks which harnesses are set up (checkboxes); once chosen, the
 * combobox lists their models grouped by harness.
 */
export function GeneratePanel({
	orpc,
	progress,
	history,
	onGenerate,
}: GeneratePanelProps): React.ReactElement {
	const { harnesses } = useHarnesses(orpc);
	const [enabledHarnessIds, setEnabledHarnessIds] = useEnabledHarnesses();
	const [selection, setSelection] = useState<ModelSelection | null>(null);
	const [configuring, setConfiguring] = useState(false);

	if (progress.phase === "running") {
		return (
			<div className="flex flex-1 items-center justify-center px-6">
				<GenerationTimeline history={history} />
			</div>
		);
	}

	if (enabledHarnessIds === null || configuring) {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
				<EnableHarnessesPanel
					harnesses={harnesses}
					initialSelected={enabledHarnessIds ?? []}
					onConfirm={(selected) => {
						setEnabledHarnessIds(selected);
						setConfiguring(false);
					}}
				/>
			</div>
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
					enabledHarnessIds={enabledHarnessIds}
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
			<Button onClick={() => setConfiguring(true)} size="sm" variant="ghost">
				Configure harnesses
			</Button>
		</Empty>
	);
}
