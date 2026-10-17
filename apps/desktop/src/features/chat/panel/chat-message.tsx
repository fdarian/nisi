"use client";

import { isTextUIPart, type UIMessage } from "ai";
import { ProseMarkdown } from "#/features/pull-request/prose-markdown";
import { ChatTrace, isTraceStepPart, type TraceStep } from "./chat-trace";

type Segment =
	| { kind: "text"; key: number; text: string }
	| { kind: "trace"; key: number; steps: TraceStep[] };

/**
 * Cuts a message into text blocks and trace groups. `step-start` and any part
 * type this UI doesn't render are skipped without ending a run, and so is a
 * text part with no visible text — a streaming reply opens one empty before
 * its first delta, which would otherwise split the run it follows.
 */
function segmentParts(parts: UIMessage["parts"]): Segment[] {
	const segments: Segment[] = [];
	parts.forEach((part, index) => {
		if (isTextUIPart(part)) {
			if (part.text.trim() === "") return;
			segments.push({ kind: "text", key: index, text: part.text });
			return;
		}
		if (!isTraceStepPart(part)) return;
		const step = { key: index, part };
		const last = segments[segments.length - 1];
		if (last?.kind === "trace") {
			last.steps.push(step);
		} else {
			segments.push({ kind: "trace", key: index, steps: [step] });
		}
	});
	return segments;
}

type ChatMessageProps = {
	message: UIMessage;
	/** Whether the chat is streaming into this message right now. */
	streaming: boolean;
	repoRoot: string | undefined;
};

export function ChatMessage({
	message,
	streaming,
	repoRoot,
}: ChatMessageProps): React.ReactElement {
	if (message.role === "user") {
		return (
			<div className="flex min-w-0 flex-col items-end gap-1.5">
				{segmentParts(message.parts).map((segment) =>
					segment.kind === "text" ? (
						<div
							className="min-w-0 max-w-[85%] wrap-anywhere rounded-2xl bg-primary px-3 py-1.5 text-primary-foreground text-sm"
							key={segment.key}
						>
							<span className="whitespace-pre-wrap wrap-anywhere">
								{segment.text}
							</span>
						</div>
					) : null,
				)}
			</div>
		);
	}

	const segments = segmentParts(message.parts);
	return (
		<div className="flex min-w-0 flex-col gap-2">
			{segments.map((segment, index) =>
				segment.kind === "text" ? (
					<div
						className="min-w-0 wrap-anywhere text-foreground text-sm leading-relaxed"
						key={segment.key}
					>
						<div className="flex flex-col gap-3">
							<ProseMarkdown>{segment.text}</ProseMarkdown>
						</div>
					</div>
				) : (
					<ChatTrace
						key={segment.key}
						repoRoot={repoRoot}
						steps={segment.steps}
						streaming={streaming && index === segments.length - 1}
					/>
				),
			)}
		</div>
	);
}
