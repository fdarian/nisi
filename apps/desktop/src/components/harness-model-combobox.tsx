"use client";

/** Shared walkthrough/chat model picker. Groups keep headers out of filtering and keyboard navigation; search matches tokens across harness and model details. */
import { type KeyboardEvent as ReactKeyboardEvent, useMemo } from "react";
import {
	matchesModelQuery,
	type SearchableModelOption,
} from "#/components/harness-model-search";
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
import type {
	HarnessId,
	HarnessInfo,
	HarnessModels,
} from "#/features/pull-request/walkthrough/walkthrough-data";

export type ModelSelection = {
	harness: HarnessId;
	modelId: string | undefined;
};

type ModelOption = SearchableModelOption & {
	value: string;
	harness: HarnessId;
};

type ModelOptionGroup = { label: string; items: readonly ModelOption[] };

function optionValue(harness: HarnessId, modelId: string | undefined): string {
	return `${harness}::${modelId ?? ""}`;
}

/** Base UI ignores modified keys, so forward Ctrl+N/P as unmodified arrows through its own list navigation. */
function handleModelPickerKeyDown(
	event: ReactKeyboardEvent<HTMLInputElement>,
): void {
	if (
		!event.ctrlKey ||
		event.metaKey ||
		event.altKey ||
		event.shiftKey ||
		(event.key !== "n" && event.key !== "p")
	) {
		return;
	}

	event.preventDefault();
	event.currentTarget.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: event.key === "n" ? "ArrowDown" : "ArrowUp",
			bubbles: true,
			cancelable: true,
		}),
	);
}

type HarnessModelComboboxProps = {
	harnesses: readonly HarnessInfo[];
	modelsByHarness: Partial<Record<HarnessId, HarnessModels>>;
	isLoading?: boolean;
	loadingHarnesses?: readonly HarnessId[];
	value: ModelSelection | null;
	onChange: (value: ModelSelection) => void;
};

/** Only enabled harnesses get a model group — `HarnessInfo.enabled` already reflects `@repo/settings`'s `enabledHarnesses` server-side, so there's no separate id set to thread through. */
export function HarnessModelCombobox({
	harnesses,
	modelsByHarness,
	isLoading = false,
	loadingHarnesses = [],
	value,
	onChange,
}: HarnessModelComboboxProps): React.ReactElement {
	const groups = useMemo<readonly ModelOptionGroup[]>(() => {
		const result: ModelOptionGroup[] = [];
		for (const harness of harnesses) {
			if (!harness.enabled) continue;
			const discovery = modelsByHarness[harness.id];
			if (discovery === undefined) continue;
			const items = discovery.models.map(
				(model): ModelOption => ({
					value: optionValue(harness.id, model.id),
					label: model.label,
					harness: harness.id,
					harnessLabel: harness.label,
					modelId: model.id,
				}),
			);
			if (items.length === 0) continue;
			result.push({ label: harness.label, items });
		}
		return result;
	}, [harnesses, modelsByHarness]);

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
			filter={matchesModelQuery}
			items={groups}
			onValueChange={(option) => {
				if (option === null) return;
				onChange({ harness: option.harness, modelId: option.modelId });
			}}
			value={selectedOption}
		>
			<ComboboxInput
				onKeyDown={handleModelPickerKeyDown}
				placeholder="Choose a model…"
			/>
			<ComboboxPopup>
				{loadingHarnesses.length > 0 && (
					<p className="px-2 py-1 text-muted-foreground text-xs" role="status">
						Loading{" "}
						{harnesses
							.filter((harness) => loadingHarnesses.includes(harness.id))
							.map((harness) => harness.label)
							.join(", ")}{" "}
						models…
					</p>
				)}
				<ComboboxEmpty>
					{isLoading ? "Loading models…" : "No matching models."}
				</ComboboxEmpty>
				<ComboboxList scrollFadeTop={false}>
					{(group: ModelOptionGroup) => (
						<ComboboxGroup items={group.items} key={group.label}>
							<ComboboxGroupLabel className="sticky top-0 z-10 bg-popover">
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
