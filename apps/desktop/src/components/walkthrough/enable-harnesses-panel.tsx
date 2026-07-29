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

/** Why a harness's checkbox is disabled here — Pi has no CLI of its own, so this only ever applies to the other three. */
const UNAVAILABLE_REASON =
	"Not found on your PATH or common install locations.";

/**
 * First-use onboarding: which harnesses the user actually has CLIs
 * installed/authenticated for. `harness.available` (a live
 * `@repo/bin-resolver` check — see `HarnessInfo`'s doc) disables the ones
 * that aren't actually on disk, with a reason so an unavailable harness
 * still reads as "an option you could install" rather than "broken" — the
 * choice itself is asked and written straight through `settings.update`'s
 * `enabledHarnesses` for whichever remain selectable, since the sidecar is
 * what spawns the agents, so it's the authoritative store, not a
 * client-side shadow copy.
 */
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
					<div className="flex flex-col gap-0.5" key={harness.id}>
						<label
							className="flex items-center gap-2 text-sm not-data-disabled:cursor-pointer data-disabled:opacity-64"
							data-disabled={!harness.available || undefined}
							htmlFor={`harness-${harness.id}`}
						>
							<Checkbox
								disabled={!harness.available}
								id={`harness-${harness.id}`}
								name={harness.id}
							/>
							{harness.label}
						</label>
						{!harness.available && (
							<p className="pl-6.5 text-muted-foreground text-xs">
								{UNAVAILABLE_REASON}
							</p>
						)}
					</div>
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
