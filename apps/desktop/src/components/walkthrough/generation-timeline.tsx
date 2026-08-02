"use client";

import {
	CheckIcon,
	LoaderIcon,
	RefreshCwIcon,
	WrenchIcon,
	XIcon,
} from "lucide-react";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Spinner } from "#/components/ui/spinner";
import type { GenerateEvent, GenerationLogEntry } from "#/lib/walkthrough-data";

type GenerationTimelineProps = {
	history: readonly GenerationLogEntry[];
};

/**
 * Cold start is ~13-28s before the agent produces anything, plus retry turns
 * for coverage validation — a bare spinner would leave the user guessing for
 * that whole stretch. This renders every event the stream has emitted so far
 * as a small log, so bootstrapping/working/validation-failed/retrying are all
 * distinguishable, not just "loading".
 *
 * An empty `history` is the pending window right after the click
 * (`GenerationProgress`'s `"starting"`): the sidecar doesn't resolve
 * `generate` until it has an event, so there's genuinely nothing to log yet.
 * It renders as the same headline row with the same spinner, so the first
 * event that lands only adds the log beneath it — no second spinner, no
 * remount.
 */
export function GenerationTimeline({
	history,
}: GenerationTimelineProps): React.ReactElement {
	const last = history[history.length - 1];
	const isTerminal =
		last?.event.type === "done" || last?.event.type === "failed";

	return (
		<div className="flex w-full max-w-md flex-col gap-3">
			<div className="flex items-center gap-2 text-foreground text-sm">
				{isTerminal ? (
					<EventIcon event={last.event} />
				) : (
					<Spinner className="size-4" />
				)}
				<span className="font-medium">{headline(last?.event)}</span>
			</div>
			{history.length === 0 ? (
				<p className="pl-6 text-muted-foreground text-xs leading-relaxed">
					Reading this PR's diff and booting the harness CLI — the first step
					shows up here once the agent answers.
				</p>
			) : (
				// ScrollArea's `className` lands on its Root, but Root is `display:
				// block` with `height: auto` clamped only by `max-height` — that
				// clamp never counts as a *definite* height in CSS, so the
				// Viewport child's `h-full` can't resolve against it and the list
				// just grows past the cap instead of scrolling. A grid row sized
				// `1fr` does give Root a definite size to fill, so the cap has to
				// live on this wrapper instead of `ScrollArea` itself.
				<div className="grid max-h-64 grid-rows-[1fr]">
					<ScrollArea scrollFade>
						<ul className="flex flex-col gap-1.5 border-l pl-3">
							{history.map((entry) => (
								<li
									className="flex items-start gap-2 text-muted-foreground text-xs"
									key={entry.id}
								>
									<EventIcon event={entry.event} />
									<span className="leading-relaxed">
										{describeEvent(entry.event)}
									</span>
								</li>
							))}
						</ul>
					</ScrollArea>
				</div>
			)}
		</div>
	);
}

function headline(event: GenerateEvent | undefined): string {
	if (event === undefined) return "Starting the agent…";
	switch (event.type) {
		case "bootstrapping":
			return "Setting up the harness…";
		case "turn-started":
			return `Turn ${event.turn} — the agent is working…`;
		case "tool-call":
			return "Writing the walkthrough…";
		case "validation-failed":
			return `Turn ${event.turn} — checking coverage…`;
		case "retrying":
			return `Starting turn ${event.turn}…`;
		case "done":
			return "Walkthrough ready.";
		case "failed":
			return "Generation failed.";
	}
}

function describeEvent(event: GenerateEvent): string {
	switch (event.type) {
		case "bootstrapping":
			return "Bootstrapping the sandboxed harness session — slow on a cold CLI install.";
		case "turn-started":
			return `Turn ${event.turn} started.`;
		case "tool-call":
			return describeToolCall(event);
		case "validation-failed":
			return `Coverage check failed on turn ${event.turn} — ${event.feedback}`;
		case "retrying":
			return `Retrying as turn ${event.turn}.`;
		case "done":
			return "Walkthrough generated.";
		case "failed":
			return event.message;
	}
}

/** `input`'s shape varies per harness/tool (see `GenerateEvent`'s `tool-call` variant) and isn't contractually guaranteed even for a given `toolName` — narrow with a type guard and fall back rather than casting. */
function describeToolCall(
	event: Extract<GenerateEvent, { type: "tool-call" }>,
): string {
	if (event.toolName === "read") {
		const filePath = readStringField(event.input, "file_path");
		if (filePath !== undefined) return `Read ${basename(filePath)}`;
	}
	if (event.toolName === "bash") {
		const command = readStringField(event.input, "command");
		if (command !== undefined) return `Ran ${truncate(command, 60)}`;
	}
	return `Called ${event.toolName}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readStringField(input: unknown, field: string): string | undefined {
	if (!isRecord(input)) return undefined;
	const value = input[field];
	return typeof value === "string" ? value : undefined;
}

function basename(filePath: string): string {
	const segments = filePath.split("/");
	return segments[segments.length - 1] ?? filePath;
}

function truncate(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function EventIcon({ event }: { event: GenerateEvent }): React.ReactElement {
	if (event.type === "failed") {
		return (
			<XIcon className="mt-0.5 size-3 shrink-0 text-destructive-foreground" />
		);
	}
	if (event.type === "done") {
		return (
			<CheckIcon className="mt-0.5 size-3 shrink-0 text-success-foreground" />
		);
	}
	if (event.type === "validation-failed") {
		return (
			<RefreshCwIcon className="mt-0.5 size-3 shrink-0 text-warning-foreground" />
		);
	}
	if (event.type === "tool-call") {
		return <WrenchIcon className="mt-0.5 size-3 shrink-0" />;
	}
	return <LoaderIcon className="mt-0.5 size-3 shrink-0 animate-spin" />;
}
