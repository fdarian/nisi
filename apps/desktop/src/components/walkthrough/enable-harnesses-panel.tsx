"use client";

import { useState } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import { CheckboxGroup } from "#/components/ui/checkbox-group";
import type { HarnessId, HarnessInfo } from "#/lib/walkthrough-data";

type EnableHarnessesPanelProps = {
	harnesses: readonly HarnessInfo[];
	initialSelected: readonly HarnessId[];
	onConfirm: (selected: readonly HarnessId[]) => void;
};

/** First-use onboarding: which harnesses the user actually has CLIs installed/authenticated for — see `use-enabled-harnesses.ts` on why this can't be detected and has to be asked. */
export function EnableHarnessesPanel({
	harnesses,
	initialSelected,
	onConfirm,
}: EnableHarnessesPanelProps): React.ReactElement {
	const [selected, setSelected] = useState<string[]>([...initialSelected]);

	return (
		<div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border p-4">
			<div className="flex flex-col gap-1">
				<h3 className="font-medium text-sm">
					Which harnesses do you have set up?
				</h3>
				<p className="text-muted-foreground text-xs">
					nisi drives your own local CLI installs — pick the ones you've already
					logged into. You can change this later.
				</p>
			</div>
			<CheckboxGroup onValueChange={setSelected} value={selected}>
				{harnesses.map((harness) => (
					<label
						className="flex cursor-pointer items-center gap-2 text-sm"
						htmlFor={`harness-${harness.id}`}
						key={harness.id}
					>
						<Checkbox id={`harness-${harness.id}`} name={harness.id} />
						{harness.label}
					</label>
				))}
			</CheckboxGroup>
			<Button
				disabled={selected.length === 0}
				onClick={() => onConfirm(selected as HarnessId[])}
				size="sm"
			>
				Continue
			</Button>
		</div>
	);
}
