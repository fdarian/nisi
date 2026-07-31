"use client";

/** The generate empty-state's model picker — a typeable, grouped-by-harness combobox (coss ui's `Combobox`, Base UI-backed). Grouping is real `Combobox.Group`/`Combobox.GroupLabel` structure, not a flat list with a prefix, so the group headers stay out of the filter/keyboard-nav text. */
import { useMemo } from "react";
import {
	Combobox,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxGroupLabel,
	ComboboxInput,
	ComboboxItem,
	ComboboxList,
	ComboboxPopup,
} from "#/components/ui/combobox";
import { cn } from "#/lib/utils";
import type { HarnessId, HarnessInfo } from "#/lib/walkthrough-data";

export type ModelSelection = {
	harness: HarnessId;
	modelId: string | undefined;
};

type ModelOption = {
	value: string;
	label: string;
	harness: HarnessId;
	modelId: string | undefined;
};

type ModelOptionGroup = { label: string; items: readonly ModelOption[] };

function optionValue(harness: HarnessId, modelId: string | undefined): string {
	return `${harness}::${modelId ?? ""}`;
}

type HarnessModelComboboxProps = {
	harnesses: readonly HarnessInfo[];
	value: ModelSelection | null;
	onChange: (value: ModelSelection) => void;
	/**
	 * Shown in place of the popup's default "No matching models." when every
	 * group is empty. Lets `GeneratePanel` distinguish "discovery failed for
	 * every enabled harness" (an actionable, specific message) from a genuine
	 * no-search-results state, which `HarnessInfo.modelsStatus` alone
	 * determines but this component has no other reason to know about.
	 */
	emptyMessage?: string;
	/** Pins each group's label to the top of the popup while its models scroll underneath. Disables the popup's top scroll-fade, since the sticky label already occludes the content behind it. */
	stickyGroupLabels?: boolean;
};

/** Only enabled harnesses get a model group — `HarnessInfo.enabled` already reflects `@repo/settings`'s `enabledHarnesses` server-side, so there's no separate id set to thread through. */
export function HarnessModelCombobox({
	harnesses,
	value,
	onChange,
	emptyMessage = "No matching models.",
	stickyGroupLabels = true,
}: HarnessModelComboboxProps): React.ReactElement {
	const groups = useMemo<readonly ModelOptionGroup[]>(() => {
		const result: ModelOptionGroup[] = [];
		for (const harness of harnesses) {
			if (!harness.enabled) continue;
			const items = harness.models.map(
				(model): ModelOption => ({
					value: optionValue(harness.id, model.id),
					label: model.label,
					harness: harness.id,
					modelId: model.id,
				}),
			);
			if (items.length === 0) continue;
			result.push({ label: harness.label, items });
		}
		return result;
	}, [harnesses]);

	const selectedOption = useMemo(() => {
		if (value === null) return null;
		for (const group of groups) {
			const match = group.items.find(
				(option) =>
					option.harness === value.harness && option.modelId === value.modelId,
			);
			if (match) return match;
		}
		return null;
	}, [groups, value]);

	return (
		<Combobox<ModelOption>
			items={groups}
			onValueChange={(option) => {
				if (option === null) return;
				onChange({ harness: option.harness, modelId: option.modelId });
			}}
			value={selectedOption}
		>
			<ComboboxInput placeholder="Choose a model…" />
			<ComboboxPopup>
				<ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
				<ComboboxList scrollFadeTop={!stickyGroupLabels}>
					{(group: ModelOptionGroup) => (
						<ComboboxGroup items={group.items} key={group.label}>
							<ComboboxGroupLabel
								className={cn(
									stickyGroupLabels && "sticky top-0 z-10 bg-popover",
								)}
							>
								{group.label}
							</ComboboxGroupLabel>
							{group.items.map((option) => (
								<ComboboxItem key={option.value} value={option}>
									{option.label}
								</ComboboxItem>
							))}
						</ComboboxGroup>
					)}
				</ComboboxList>
			</ComboboxPopup>
		</Combobox>
	);
}
