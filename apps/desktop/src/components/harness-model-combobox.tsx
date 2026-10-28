"use client";

/** Shared walkthrough/chat model picker. Groups keep headers out of filtering and keyboard navigation; search matches tokens across harness and model details. */
import { SearchIcon } from "lucide-react";
import {
	type ReactElement,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	useMemo,
} from "react";
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
	ComboboxTrigger,
} from "#/components/ui/combobox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
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

/** What a model trigger should read: the model's label, else its harness's when only the harness was picked, else `null` before any choice. */
export function selectionLabel(
	harnesses: readonly HarnessInfo[],
	modelsByHarness: Partial<Record<HarnessId, HarnessModels>>,
	value: ModelSelection | null,
): string | null {
	if (value === null) return null;
	if (value.modelId !== undefined) {
		const model = modelsByHarness[value.harness]?.models.find(
			(candidate) => candidate.id === value.modelId,
		);
		if (model !== undefined) return model.label;
	}
	const harness = harnesses.find((candidate) => candidate.id === value.harness);
	return harness === undefined ? null : harness.label;
}

type HarnessModelComboboxProps = {
	harnesses: readonly HarnessInfo[];
	modelsByHarness: Partial<Record<HarnessId, HarnessModels>>;
	isLoading?: boolean;
	loadingHarnesses?: readonly HarnessId[];
	value: ModelSelection | null;
	onChange: (value: ModelSelection) => void;
	/** Swaps the inline input for this element as the popup's opener, with the search input moved inside the popup. */
	trigger?: ReactElement;
	/** Shown on hover/focus of `trigger`; only meaningful alongside it. */
	triggerTooltip?: ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};

/** Only enabled harnesses get a model group — `HarnessInfo.enabled` already reflects `@repo/settings`'s `enabledHarnesses` server-side, so there's no separate id set to thread through. */
export function HarnessModelCombobox({
	harnesses,
	modelsByHarness,
	isLoading = false,
	loadingHarnesses = [],
	value,
	onChange,
	trigger,
	triggerTooltip,
	open,
	onOpenChange,
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
			onOpenChange={onOpenChange}
			onValueChange={(option) => {
				if (option === null) return;
				onChange({ harness: option.harness, modelId: option.modelId });
			}}
			open={open}
			value={selectedOption}
		>
			{trigger === undefined ? (
				<ComboboxInput
					onKeyDown={handleModelPickerKeyDown}
					placeholder="Choose a model…"
				/>
			) : (
				<Tooltip>
					<TooltipTrigger render={<ComboboxTrigger render={trigger} />} />
					<TooltipPopup>{triggerTooltip}</TooltipPopup>
				</Tooltip>
			)}
			<ComboboxPopup
				{...(trigger === undefined
					? {}
					: {
							side: "top" as const,
							align: "end" as const,
							className: "w-64",
							// Mounting the popup on first open cost ~150ms; paying it up front
							// makes the shortcut feel instant.
							portalProps: { keepMounted: true },
						})}
			>
				{trigger !== undefined && (
					<div className="border-b p-1">
						<ComboboxInput
							className="border-transparent! bg-transparent! shadow-none before:hidden has-focus-visible:ring-0"
							onKeyDown={handleModelPickerKeyDown}
							placeholder="Search models…"
							showTrigger={false}
							startAddon={<SearchIcon />}
						/>
					</div>
				)}
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
								<ComboboxItem
									className="grid-cols-[1rem_minmax(0,1fr)]"
									key={option.value}
									value={option}
								>
									<span className="block truncate" title={option.label}>
										{option.label}
									</span>
								</ComboboxItem>
							))}
						</ComboboxGroup>
					)}
				</ComboboxList>
			</ComboboxPopup>
		</Combobox>
	);
}
