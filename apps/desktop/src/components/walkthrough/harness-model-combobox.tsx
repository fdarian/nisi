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
	enabledHarnessIds: readonly HarnessId[];
	value: ModelSelection | null;
	onChange: (value: ModelSelection) => void;
};

export function HarnessModelCombobox({
	harnesses,
	enabledHarnessIds,
	value,
	onChange,
}: HarnessModelComboboxProps): React.ReactElement {
	const enabledSet = useMemo(
		() => new Set(enabledHarnessIds),
		[enabledHarnessIds],
	);

	const groups = useMemo<readonly ModelOptionGroup[]>(
		() =>
			harnesses
				.filter((harness) => enabledSet.has(harness.id))
				.map((harness) => ({
					label: harness.label,
					items: harness.models.map(
						(model): ModelOption => ({
							value: optionValue(harness.id, model.id),
							label: model.label,
							harness: harness.id,
							modelId: model.id,
						}),
					),
				}))
				.filter((group) => group.items.length > 0),
		[harnesses, enabledSet],
	);

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
				<ComboboxEmpty>No matching models.</ComboboxEmpty>
				<ComboboxList>
					{(group: ModelOptionGroup) => (
						<ComboboxGroup items={group.items} key={group.label}>
							<ComboboxGroupLabel>{group.label}</ComboboxGroupLabel>
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
