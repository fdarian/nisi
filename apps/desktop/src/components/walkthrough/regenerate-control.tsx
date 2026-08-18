"use client";

import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	HarnessModelCombobox,
	type ModelSelection,
} from "#/components/walkthrough/harness-model-combobox";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { cn } from "#/lib/utils";
import type { HarnessId } from "#/lib/walkthrough-data";
import { useHarnesses } from "#/lib/walkthrough-data";

type RegenerateControlProps = {
	orpc: SidecarQueryUtils;
	/** The harness/model the *current* stored walkthrough was generated with — the picker's default, so Regenerate reads as "do it again" rather than forcing a fresh choice every time. */
	defaultHarness: HarnessId;
	defaultModel: string | null;
	onRegenerate: (harness: HarnessId, model: string | undefined) => void;
	/** `OutdatedBanner` wants the button to read as a warning-adjacent action (`"outline"`, its default); `NarrativePane`'s always-there footer wants it to read as a quiet trailing action instead. */
	buttonVariant?: "outline" | "ghost";
	className?: string;
};

/**
 * The harness/model picker paired with a Regenerate button — the one
 * control that actually starts a walkthrough regeneration. Shared by
 * `OutdatedBanner` (shown only once files have drifted) and `NarrativePane`'s
 * persistent footer (always available, so a reader isn't stuck waiting for
 * drift to ask for a fresh pass), rather than duplicated between them. Owns
 * its own `ModelSelection` state, seeded from whatever produced the
 * walkthrough currently on screen.
 */
export function RegenerateControl({
	orpc,
	defaultHarness,
	defaultModel,
	onRegenerate,
	buttonVariant = "outline",
	className,
}: RegenerateControlProps): React.ReactElement {
	const { harnesses } = useHarnesses(orpc);
	const [selection, setSelection] = useState<ModelSelection>({
		harness: defaultHarness,
		modelId: defaultModel ?? undefined,
	});

	return (
		<div className={cn("flex shrink-0 items-center gap-2", className)}>
			<div className="w-56">
				<HarnessModelCombobox
					harnesses={harnesses}
					onChange={setSelection}
					value={selection}
				/>
			</div>
			<Button
				onClick={() => onRegenerate(selection.harness, selection.modelId)}
				size="sm"
				variant={buttonVariant}
			>
				Regenerate
			</Button>
		</div>
	);
}
