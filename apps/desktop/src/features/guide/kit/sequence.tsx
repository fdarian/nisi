"use client";

import { cn } from "cn";
import { Children, isValidElement, type ReactNode, useState } from "react";
import { useGuideContext } from "../guide-context";
import { colorForArea } from "./area-colors";

type StepProps = {
	lane: string;
	/** The `id` of an `Area`; sets the step's color and ties it to that card's hover. */
	area?: string;
	/** Relative width. Nothing in a Sequence is to scale. */
	span: number;
	children?: ReactNode;
};
type WaitProps = { lane: string; span: number; children?: ReactNode };
type EventProps = { lane: string; area?: string; at: number };
type SegmentProps = { caption?: string; children?: ReactNode };

/** Work in a lane. Laid out left to right after the lane's previous step or wait. */
export function Step(_props: StepProps): null {
	return null;
}

/** A lane idle: striped and not colored. Use it to hold a lane back until another lane's step is done. */
export function Wait(_props: WaitProps): null {
	return null;
}

/** A tick mark at `at`, measured from the left edge in the same units as `span`. */
export function Event(_props: EventProps): null {
	return null;
}

/** How things ran before the change. Holds `Step`, `Wait` and `Event`; `caption` is the line beneath. */
export function Before(_props: SegmentProps): null {
	return null;
}

/** How things run after the change. Same children as `Before`. */
export function After(_props: SegmentProps): null {
	return null;
}

type Item =
	| { kind: "step"; lane: string; props: StepProps; start: number }
	| { kind: "wait"; lane: string; props: WaitProps; start: number }
	| { kind: "event"; lane: string; props: EventProps; start: number };

type Segment = { caption?: string; items: Item[]; length: number };

function readSegment(
	title: string,
	lanes: readonly string[],
	props: SegmentProps,
	collect: (area: string) => void,
): Segment {
	const cursors = new Map<string, number>();
	const items: Item[] = [];
	let length = 0;
	const cursor = (lane: string): number => {
		if (!lanes.includes(lane)) {
			throw new Error(
				`<Sequence title="${title}"> has no lane "${lane}" (lanes: ${lanes.join(", ")})`,
			);
		}
		return cursors.get(lane) ?? 0;
	};
	const place = (lane: string, span: number): number => {
		if (typeof span !== "number" || !(span > 0)) {
			throw new Error(
				`<Sequence title="${title}"> lane "${lane}" has a step or wait whose span isn't a positive number`,
			);
		}
		const start = cursor(lane);
		cursors.set(lane, start + span);
		length = Math.max(length, start + span);
		return start;
	};
	for (const child of Children.toArray(props.children)) {
		if (!isValidElement(child)) continue;
		if (child.type === Step) {
			const stepProps = child.props as StepProps;
			const start = place(stepProps.lane, stepProps.span);
			if (stepProps.area !== undefined) collect(stepProps.area);
			items.push({
				kind: "step",
				lane: stepProps.lane,
				props: stepProps,
				start,
			});
		} else if (child.type === Wait) {
			const waitProps = child.props as WaitProps;
			const start = place(waitProps.lane, waitProps.span);
			items.push({
				kind: "wait",
				lane: waitProps.lane,
				props: waitProps,
				start,
			});
		} else if (child.type === Event) {
			const eventProps = child.props as EventProps;
			cursor(eventProps.lane);
			length = Math.max(length, eventProps.at);
			if (eventProps.area !== undefined) collect(eventProps.area);
			items.push({
				kind: "event",
				lane: eventProps.lane,
				props: eventProps,
				start: eventProps.at,
			});
		} else {
			throw new Error(
				`<Sequence title="${title}"> takes <Step>, <Wait> and <Event> inside <Before>/<After>`,
			);
		}
	}
	if (length === 0) {
		throw new Error(
			`<Sequence title="${title}"> has an empty <Before>/<After>`,
		);
	}
	return { caption: props.caption, items, length };
}

function Track(props: { lane: string; segment: Segment }): React.ReactElement {
	const guide = useGuideContext();
	const percent = (value: number) => `${(value / props.segment.length) * 100}%`;
	const dimmed = (area: string | undefined) =>
		guide.hoveredArea !== null && area !== guide.hoveredArea;
	return (
		<div className="relative h-[30px] rounded-md bg-[repeating-linear-gradient(90deg,transparent_0,transparent_calc(10%-1px),var(--border)_calc(10%-1px),var(--border)_10%)]">
			{props.segment.items.map((item, index) => {
				if (item.lane !== props.lane) return null;
				const key = `${item.kind}-${index}`;
				if (item.kind === "event") {
					return (
						<span
							className={cn(
								"absolute top-1.5 h-[18px] w-2 -translate-x-1/2 rounded-[3px] transition-opacity",
								colorForArea(guide.areaOrder, item.props.area).dot,
								dimmed(item.props.area) && "opacity-25",
							)}
							key={key}
							style={{ left: percent(item.start) }}
						/>
					);
				}
				const width = percent(item.props.span);
				const label = item.props.children;
				return (
					<span
						className={cn(
							"absolute top-[3px] h-6 overflow-hidden text-ellipsis whitespace-nowrap rounded-[5px] border px-2 text-[11.5px] leading-[22px] transition-opacity [&_p]:m-0 [&_p]:inline",
							item.kind === "wait"
								? "bg-[repeating-linear-gradient(135deg,var(--muted)_0,var(--muted)_6px,transparent_6px,transparent_12px)] text-muted-foreground"
								: colorForArea(guide.areaOrder, item.props.area).step,
							dimmed(item.kind === "step" ? item.props.area : undefined) &&
								"opacity-25",
						)}
						key={key}
						style={{ left: percent(item.start), width }}
						title={typeof label === "string" ? label : undefined}
					>
						{label}
					</span>
				);
			})}
		</div>
	);
}

type SequenceProps = {
	title: string;
	lanes: readonly string[];
	children: ReactNode;
};

/** A swimlane of what ran when, for a change about ordering, timing or request flow. `<Before>` and `<After>` each hold the lanes' steps; with both, a toggle (After by default) switches between them. */
export function Sequence(props: SequenceProps): React.ReactElement {
	const guide = useGuideContext();
	const [chosen, setChosen] = useState<"before" | "after">("after");
	const collect = (area: string) => guide.collector?.stepAreas.push(area);
	if (!Array.isArray(props.lanes) || props.lanes.length === 0) {
		throw new Error(
			`<Sequence title="${props.title}"> needs lanes={["Name", …]}`,
		);
	}
	const segments = new Map<"before" | "after", Segment>();
	for (const child of Children.toArray(props.children)) {
		if (!isValidElement<SegmentProps>(child)) continue;
		if (child.type !== Before && child.type !== After) {
			throw new Error(
				`<Sequence title="${props.title}"> takes <Before> and/or <After>`,
			);
		}
		segments.set(
			child.type === Before ? "before" : "after",
			readSegment(props.title, props.lanes, child.props, collect),
		);
	}
	if (segments.size === 0) {
		throw new Error(
			`<Sequence title="${props.title}"> needs <Before> or <After>`,
		);
	}
	const shown = segments.has(chosen) ? chosen : segments.keys().next().value;
	const segment = segments.get(shown as "before" | "after") as Segment;
	return (
		<figure className="m-0 flex flex-col gap-2.5 rounded-xl border bg-card px-4 pt-3.5 pb-3">
			<div className="flex items-center gap-2.5">
				<figcaption className="font-medium text-foreground text-sm">
					{props.title}
				</figcaption>
				{segments.size === 2 && (
					<div className="ml-auto inline-flex rounded-md bg-muted p-0.5">
						{(["before", "after"] as const).map((which) => (
							<button
								aria-pressed={shown === which}
								className={cn(
									"cursor-pointer rounded px-2.5 py-0.5 text-xs capitalize",
									shown === which
										? "bg-background text-foreground shadow-xs"
										: "text-muted-foreground",
								)}
								key={which}
								onClick={() => setChosen(which)}
								type="button"
							>
								{which}
							</button>
						))}
					</div>
				)}
			</div>
			<div className="grid grid-cols-[4.5rem_1fr] items-center gap-y-2 gap-x-2">
				{props.lanes.map((lane) => (
					<LaneRow key={lane} lane={lane} segment={segment} />
				))}
				<span className="col-start-2 text-right text-[11px] text-muted-foreground">
					time →
				</span>
			</div>
			{segment.caption !== undefined && (
				<p className="m-0 text-muted-foreground text-xs">{segment.caption}</p>
			)}
		</figure>
	);
}

function LaneRow(props: {
	lane: string;
	segment: Segment;
}): React.ReactElement {
	return (
		<>
			<span className="truncate text-muted-foreground text-xs">
				{props.lane}
			</span>
			<Track lane={props.lane} segment={props.segment} />
		</>
	);
}
