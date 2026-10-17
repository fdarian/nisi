import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import { Checkbox } from "#/components/ui/checkbox";
import {
	type HarnessId,
	useHarnesses,
} from "#/features/pull-request/walkthrough/walkthrough-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { useUpdateSettings } from "./settings-data";
import { SettingsRow, SettingsSection } from "./settings-section";

export function AgentsPage(): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return <AgentsContent orpc={backend.orpc} />;
}

function AgentsContent(props: { orpc: SidecarQueryUtils }): React.ReactElement {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<h1 className="font-semibold text-2xl tracking-tight">Agents</h1>
			<HarnessesSection orpc={props.orpc} />
		</div>
	);
}

/** Why a harness's checkbox is disabled here — mirrors `EnableHarnessesPanel`'s onboarding-gate reason. */
const UNAVAILABLE_REASON = "Not found on PATH or common install locations.";

/**
 * Checkboxes for the four harnesses, written straight through
 * `settings.update` — `walkthrough.harnesses()` already reflects this same
 * field server-side (its `HarnessInfo.enabled`), so toggling here immediately
 * changes which harnesses show up in the walkthrough tab's model combobox.
 * Renders `useHarnesses`' own result directly rather than a separate static
 * list — `walkthrough.harnesses()` always reports all four regardless of
 * which are currently enabled, so there's no risk of a disabled harness being
 * impossible to re-enable from here.
 *
 * A harness's checkbox is disabled when `!harness.available` (its CLI isn't
 * on disk right now — a live check, see `HarnessInfo`'s doc), with a reason
 * so the row still reads as "install this to use it" rather than "broken."
 * An already-*enabled* harness that's since gone unavailable isn't silently
 * dropped from `enabledHarnesses` — its checkbox stays checked (and
 * disabled, so it can't be re-toggled without becoming available again) and
 * an inline warning explains why, so re-plugging in the same CLI later needs
 * no reconfiguration.
 *
 * The refresh button re-probes PATH and binary presence for a harness
 * installed while nisi was already open. Model discovery belongs to the picker.
 */
function HarnessesSection({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const { harnesses, refresh, isRefreshing } = useHarnesses(orpc);
	const update = useUpdateSettings(orpc);

	const toggleHarness = useCallback(
		(id: HarnessId, checked: boolean) => {
			const currentlyEnabled = harnesses
				.filter((harness) => harness.enabled)
				.map((harness) => harness.id);
			const next = checked
				? Array.from(new Set([...currentlyEnabled, id]))
				: currentlyEnabled.filter((enabled) => enabled !== id);
			update({ enabledHarnesses: next });
		},
		[harnesses, update],
	);

	return (
		<SettingsSection
			action={
				<Button
					aria-label="Refresh harnesses"
					loading={isRefreshing}
					onClick={refresh}
					size="icon-sm"
					variant="ghost"
				>
					<RefreshCwIcon />
				</Button>
			}
			title="Harnesses"
		>
			{harnesses.map((harness) => (
				<SettingsRow
					description={
						!harness.available
							? UNAVAILABLE_REASON
							: "Drive this harness's local CLI when generating a walkthrough."
					}
					key={harness.id}
					title={harness.label}
				>
					<div className="flex items-center gap-2">
						{harness.enabled && !harness.available && (
							<span
								className="flex items-center gap-1 text-warning-foreground text-xs"
								title="Enabled, but its CLI isn't currently found — reconnect it or refresh."
							>
								<AlertTriangleIcon className="size-3.5" />
								Missing
							</span>
						)}
						<Checkbox
							checked={harness.enabled}
							disabled={!harness.available}
							onCheckedChange={(checked) =>
								toggleHarness(harness.id, checked === true)
							}
						/>
					</div>
				</SettingsRow>
			))}
		</SettingsSection>
	);
}
