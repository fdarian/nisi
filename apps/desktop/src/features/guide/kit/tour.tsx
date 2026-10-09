"use client";

import { cn } from "cn";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import {
	Children,
	isValidElement,
	type KeyboardEvent,
	type ReactNode,
	useState,
} from "react";
import { useGuideContext } from "../guide-context";
import { PinnedImage, splitPins } from "./pinned-image";

type FrameProps = {
	title: string;
	src?: string;
	children?: ReactNode;
};

/** One step of a `Tour`. With `src` it's a screenshot (its `Pin` children mark it up); without, its children are the stage. */
export function Frame(_props: FrameProps): null {
	return null;
}

function FrameStage(props: { frame: FrameProps }): React.ReactElement {
	const content = splitPins(props.frame.children);
	return (
		<>
			{props.frame.src !== undefined ? (
				<PinnedImage
					alt={props.frame.title}
					pins={content.pins}
					src={props.frame.src}
				/>
			) : null}
			{content.rest.length > 0 && (
				<div className="flex flex-col gap-2 p-3">{content.rest}</div>
			)}
		</>
	);
}

/** Walks the reader through a flow one frame at a time: a single stage, a filmstrip to jump around, and ← → to step. */
export function Tour(props: { children: ReactNode }): React.ReactElement {
	const guide = useGuideContext();
	const frames = Children.toArray(props.children).flatMap((child) =>
		isValidElement<FrameProps>(child) && child.type === Frame
			? [child.props]
			: [],
	);
	const [index, setIndex] = useState(0);
	const current = frames[Math.min(index, frames.length - 1)];
	if (current === undefined) {
		throw new Error("<Tour> needs at least one <Frame>");
	}
	const at = Math.min(index, frames.length - 1);
	const step = (delta: number) =>
		setIndex(Math.min(frames.length - 1, Math.max(0, at + delta)));

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key === "ArrowLeft") step(-1);
		else if (event.key === "ArrowRight") step(1);
		else return;
		event.preventDefault();
	};

	if (guide.expanded === true) {
		return (
			<section
				aria-label="Tour"
				className="divide-y overflow-hidden rounded-lg border bg-card"
			>
				{frames.map((frame, frameIndex) => (
					<div key={frame.title}>
						<div className="flex items-center justify-between border-b px-3 py-1.5">
							<span className="font-medium text-sm">{frame.title}</span>
							<span className="text-muted-foreground text-xs tabular-nums">
								{`${frameIndex + 1} / ${frames.length}`}
							</span>
						</div>
						<FrameStage frame={frame} />
					</div>
				))}
			</section>
		);
	}

	return (
		<section
			aria-label="Tour"
			className="overflow-hidden rounded-lg border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
			onKeyDown={onKeyDown}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the tour has to be focusable to own ← → without a global key listener
			tabIndex={0}
		>
			<div className="flex items-center justify-between border-b px-3 py-1.5">
				<span className="font-medium text-sm">{current.title}</span>
				<span className="flex items-center gap-1 text-muted-foreground text-xs tabular-nums">
					<button
						aria-label="Previous frame"
						className="cursor-pointer rounded p-0.5 hover:bg-accent disabled:cursor-default disabled:opacity-40"
						disabled={at === 0}
						onClick={() => step(-1)}
						type="button"
					>
						<ChevronLeftIcon className="size-4" />
					</button>
					{`${at + 1} / ${frames.length}`}
					<button
						aria-label="Next frame"
						className="cursor-pointer rounded p-0.5 hover:bg-accent disabled:cursor-default disabled:opacity-40"
						disabled={at === frames.length - 1}
						onClick={() => step(1)}
						type="button"
					>
						<ChevronRightIcon className="size-4" />
					</button>
				</span>
			</div>
			<FrameStage frame={current} />
			<div className="flex gap-2 overflow-x-auto border-t bg-background p-2">
				{frames.map((frame, frameIndex) => (
					<button
						aria-label={`Go to frame ${frameIndex + 1}: ${frame.title}`}
						className={cn(
							"flex w-24 shrink-0 cursor-pointer flex-col gap-1 rounded-md border p-1 text-left text-[10.5px] text-muted-foreground",
							frameIndex === at
								? "border-sky-500 bg-accent text-foreground"
								: "hover:bg-accent",
						)}
						key={frame.title}
						onClick={() => setIndex(frameIndex)}
						type="button"
					>
						{frame.src !== undefined && (
							<img
								alt=""
								className="aspect-video w-full rounded-sm object-cover object-top"
								src={frame.src}
							/>
						)}
						<span className="truncate">
							{frameIndex + 1}. {frame.title}
						</span>
					</button>
				))}
			</div>
		</section>
	);
}
