"use client";

import type { ChatEffort } from "@repo/sidecar-api";
import { ZapIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Kbd } from "#/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "#/components/ui/popover";
import { Slider } from "#/components/ui/slider";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";

const EFFORT_LEVELS: readonly { value: ChatEffort; label: string }[] = [
	{ value: "low", label: "Low" },
	{ value: "medium", label: "Medium" },
	{ value: "high", label: "High" },
	{ value: "xhigh", label: "Extra high" },
	{ value: "max", label: "Max" },
];

export const DEFAULT_CHAT_EFFORT: ChatEffort = "high";

function levelIndex(effort: ChatEffort): number {
	return EFFORT_LEVELS.findIndex((level) => level.value === effort);
}

export function effortLabel(effort: ChatEffort): string {
	return EFFORT_LEVELS[levelIndex(effort)].label;
}

type ChatEffortPickerProps = {
	value: ChatEffort;
	onChange: (value: ChatEffort) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
};

export function ChatEffortPicker({
	value,
	onChange,
	open,
	onOpenChange,
}: ChatEffortPickerProps): React.ReactElement {
	return (
		<Popover onOpenChange={onOpenChange} open={open}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button
									className="text-muted-foreground data-popup-open:bg-accent"
									size="xs"
									type="button"
									variant="ghost"
								/>
							}
						>
							{effortLabel(value)}
						</PopoverTrigger>
					}
				/>
				<TooltipPopup>
					Effort <Kbd>⇧⌘E</Kbd>
				</TooltipPopup>
			</Tooltip>
			<PopoverPopup
				align="end"
				className="w-60"
				portalProps={{ keepMounted: true }}
				side="top"
			>
				<div className="flex flex-col gap-3">
					<div className="flex items-center justify-center gap-2 text-sm">
						<ZapIcon className="size-4 text-muted-foreground" />
						<span className="font-medium">{effortLabel(value)}</span>
					</div>
					<div className="flex flex-col gap-2">
						<Slider
							aria-label="Effort"
							max={EFFORT_LEVELS.length - 1}
							min={0}
							onValueChange={(next) => {
								const index = typeof next === "number" ? next : next[0];
								onChange(EFFORT_LEVELS[index].value);
							}}
							step={1}
							value={levelIndex(value)}
						/>
						<div aria-hidden="true" className="flex justify-between px-2">
							{EFFORT_LEVELS.map((level) => (
								<span
									className="size-1 rounded-full bg-muted-foreground/40"
									key={level.value}
								/>
							))}
						</div>
					</div>
				</div>
			</PopoverPopup>
		</Popover>
	);
}
