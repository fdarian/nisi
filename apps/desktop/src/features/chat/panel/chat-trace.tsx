"use client";

/**
 * The "chain of thought" trace: one collapsible group per maximal run of
 * consecutive non-text parts (tool calls and reasoning) in an assistant
 * message. The grouping itself lives in `chat-message.tsx`; this file renders
 * a run once it's been cut.
 */
import {
	type DynamicToolUIPart,
	getToolName,
	isReasoningUIPart,
	isToolUIPart,
	type ReasoningUIPart,
	type ToolUIPart,
	type UIDataTypes,
	type UIMessagePart,
	type UITools,
} from "ai";
import {
	ChevronRightIcon,
	CircleAlertIcon,
	CircleCheckIcon,
	FileTextIcon,
	LoaderCircleIcon,
	type LucideIcon,
	SearchIcon,
	SparklesIcon,
	TerminalIcon,
	WrenchIcon,
} from "lucide-react";
import { useState } from "react";
import { ShimmerText } from "#/components/shimmer-text";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";

export type TraceStepPart = ToolUIPart | DynamicToolUIPart | ReasoningUIPart;

export type TraceStep = {
	/** The part's index in its message — stable, since `parts` is append-only while streaming. */
	key: number;
	part: TraceStepPart;
};

export function isTraceStepPart(
	part: UIMessagePart<UIDataTypes, UITools>,
): part is TraceStepPart {
	return isToolUIPart(part) || isReasoningUIPart(part);
}

function isStepInFlight(part: TraceStepPart): boolean {
	if (isReasoningUIPart(part)) return part.state === "streaming";
	return part.state === "input-streaming" || part.state === "input-available";
}

function isStepFailed(part: TraceStepPart): boolean {
	return !isReasoningUIPart(part) && part.state === "output-error";
}

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function readString(input: unknown, key: string): string | null {
	if (typeof input !== "object" || input === null) return null;
	const value: unknown = Reflect.get(input, key);
	if (typeof value !== "string" || value.trim() === "") return null;
	return value;
}

function readFirstString(
	input: unknown,
	keys: readonly string[],
): string | null {
	for (const key of keys) {
		const value = readString(input, key);
		if (value !== null) return value;
	}
	return null;
}

function relativeToRoot(path: string, repoRoot: string | undefined): string {
	if (repoRoot === undefined) return path;
	const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

type StepView = {
	icon: LucideIcon;
	label: string;
	descriptor: string | null;
	/** A second, monospace line under the headline. */
	detail: string | null;
};

function describeTool(
	part: ToolUIPart | DynamicToolUIPart,
	repoRoot: string | undefined,
): StepView {
	const name = getToolName(part);
	switch (name.toLowerCase()) {
		case "bash":
		case "shell": {
			const description = readString(part.input, "description");
			const command = readString(part.input, "command");
			if (description !== null) {
				return {
					icon: TerminalIcon,
					label: "Shell",
					descriptor: description,
					detail: command,
				};
			}
			return {
				icon: TerminalIcon,
				label: "Shell",
				descriptor: command,
				detail: null,
			};
		}
		case "read": {
			const path = readFirstString(part.input, [
				"file_path",
				"filePath",
				"path",
			]);
			return {
				icon: FileTextIcon,
				label: "Read",
				descriptor: path === null ? null : relativeToRoot(path, repoRoot),
				detail: null,
			};
		}
		case "grep":
		case "glob":
			return {
				icon: SearchIcon,
				label: "Search",
				descriptor: readString(part.input, "pattern"),
				detail: null,
			};
		default:
			return {
				icon: WrenchIcon,
				label: capitalize(name),
				descriptor: null,
				detail: null,
			};
	}
}

function StatusIcon({
	icon: Icon,
	running,
	failed,
}: {
	icon: LucideIcon;
	running: boolean;
	failed: boolean;
}): React.ReactElement {
	if (running) {
		return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />;
	}
	if (failed) {
		return <CircleAlertIcon className="size-3.5 shrink-0 text-destructive" />;
	}
	return <Icon className="size-3.5 shrink-0" />;
}

function StepHeadline({
	leading,
	label,
	descriptor,
	trailing,
}: {
	leading: React.ReactNode;
	label: React.ReactNode;
	descriptor: string | null;
	trailing?: React.ReactNode;
}): React.ReactElement {
	return (
		<span className="flex min-w-0 items-center gap-2">
			{leading}
			<span className="shrink-0 font-medium">{label}</span>
			{descriptor !== null && (
				<span className="min-w-0 truncate opacity-80" title={descriptor}>
					{descriptor}
				</span>
			)}
			{trailing}
		</span>
	);
}

function ReasoningRow({
	part,
	running,
}: {
	part: ReasoningUIPart;
	running: boolean;
}): React.ReactElement {
	const label = running ? <ShimmerText>Thinking</ShimmerText> : "Thought";
	const leading = (
		<StatusIcon failed={false} icon={SparklesIcon} running={running} />
	);

	if (part.text.trim() === "") {
		return <StepHeadline descriptor={null} label={label} leading={leading} />;
	}

	return (
		<Collapsible>
			<CollapsibleTrigger className="group block w-full cursor-pointer text-left outline-none hover:text-foreground focus-visible:text-foreground">
				<StepHeadline
					descriptor={null}
					label={label}
					leading={leading}
					trailing={
						<ChevronRightIcon className="size-3 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90" />
					}
				/>
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<p className="whitespace-pre-wrap wrap-anywhere pt-1 pl-5.5 text-xs">
					{part.text}
				</p>
			</CollapsiblePanel>
		</Collapsible>
	);
}

function ToolRow({
	part,
	running,
	repoRoot,
}: {
	part: ToolUIPart | DynamicToolUIPart;
	running: boolean;
	repoRoot: string | undefined;
}): React.ReactElement {
	const view = describeTool(part, repoRoot);
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<StepHeadline
				descriptor={view.descriptor}
				label={view.label}
				leading={
					<StatusIcon
						failed={isStepFailed(part)}
						icon={view.icon}
						running={running}
					/>
				}
			/>
			{view.detail !== null && (
				<span
					className="truncate pl-5.5 font-mono opacity-70"
					title={view.detail}
				>
					{view.detail}
				</span>
			)}
		</div>
	);
}

type ChatTraceProps = {
	steps: readonly TraceStep[];
	/** Whether this message is the one the chat is currently streaming into; a step left mid-flight by a stopped chat must not spin forever. */
	streaming: boolean;
	/** The PR worktree root, for showing file paths relative to it. */
	repoRoot: string | undefined;
};

export function ChatTrace({
	steps,
	streaming,
	repoRoot,
}: ChatTraceProps): React.ReactElement {
	const [open, setOpen] = useState<boolean>();
	const running = streaming && steps.some((step) => isStepInFlight(step.part));
	const failedCount = steps.filter((step) => isStepFailed(step.part)).length;

	return (
		<Collapsible
			className="min-w-0 text-muted-foreground text-xs"
			onOpenChange={setOpen}
			open={open ?? running}
		>
			<CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 text-left text-sm outline-none hover:text-foreground focus-visible:text-foreground">
				{running ? (
					<LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />
				) : (
					<CircleCheckIcon className="size-3.5 shrink-0" />
				)}
				{running ? (
					<ShimmerText>Working</ShimmerText>
				) : (
					<span>
						Worked through {pluralize(steps.length, "step")}
						{failedCount > 0 && `, ${failedCount} failed`}
					</span>
				)}
				<ChevronRightIcon className="size-3.5 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90" />
			</CollapsibleTrigger>
			<CollapsiblePanel>
				<div className="mt-2 ml-[7px] flex min-w-0 flex-col gap-2 border-l pb-1 pl-3">
					{steps.map((step) =>
						isReasoningUIPart(step.part) ? (
							<ReasoningRow
								key={step.key}
								part={step.part}
								running={streaming && isStepInFlight(step.part)}
							/>
						) : (
							<ToolRow
								key={step.key}
								part={step.part}
								repoRoot={repoRoot}
								running={streaming && isStepInFlight(step.part)}
							/>
						),
					)}
				</div>
			</CollapsiblePanel>
		</Collapsible>
	);
}
