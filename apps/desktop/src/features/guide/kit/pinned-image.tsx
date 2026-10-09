"use client";

import { cn } from "cn";
import {
	Children,
	Fragment,
	isValidElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

/** Declarative marker: `Shot` and `Frame` read its props and render it; on its own it draws nothing. `x` and `y` are percentages of the image. `ring` circles the point and moves the numbered badge beside it on a short leader line, so a small target (an icon, a dot) stays visible. */
export function Pin(_props: {
	x: number;
	y: number;
	ring?: boolean;
	/** With `ring`: which side of the target the badge goes. Default is the side with the most room in the image. */
	side?: "left" | "right" | "top" | "bottom";
	children?: ReactNode;
}): null {
	return null;
}

type PinSide = "left" | "right" | "top" | "bottom";
type PinProps = {
	x: number;
	y: number;
	ring?: boolean;
	side?: PinSide;
	children?: ReactNode;
};

/** How far a ringed pin's badge sits from its target, in px. */
const RING_OFFSET = 22;
const RING_SIZE = 22;

export function splitPins(children: ReactNode): {
	pins: PinProps[];
	rest: ReactNode[];
} {
	const pins: PinProps[] = [];
	const rest: ReactNode[] = [];
	for (const child of Children.toArray(children)) {
		if (isValidElement<PinProps>(child) && child.type === Pin) {
			pins.push(child.props);
		} else {
			rest.push(child);
		}
	}
	return { pins, rest };
}

const FLASH_MS = 1400;

/** The side of the image with the most room around (x, y), so a ringed pin's badge stays inside it. */
function roomiestSide(pin: PinProps): PinSide {
	const room: Array<[PinSide, number]> = [
		["right", 100 - pin.x],
		["left", pin.x],
		["bottom", 100 - pin.y],
		["top", pin.y],
	];
	return room.reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

function ringBadgeOffset(pin: PinProps): { dx: number; dy: number } {
	switch (pin.side ?? roomiestSide(pin)) {
		case "left":
			return { dx: -RING_OFFSET, dy: 0 };
		case "right":
			return { dx: RING_OFFSET, dy: 0 };
		case "top":
			return { dx: 0, dy: -RING_OFFSET };
		case "bottom":
			return { dx: 0, dy: RING_OFFSET };
	}
}

/**
 * A screenshot with numbered markers over it and a matching numbered list
 * underneath. Hovering either side highlights both; clicking a marker scrolls
 * its caption into view and flashes it, clicking a caption number flashes the
 * marker.
 */
export function PinnedImage(props: {
	src: string;
	alt: string;
	pins: readonly PinProps[];
}): React.ReactElement {
	const [hovered, setHovered] = useState<number | null>(null);
	const [flashed, setFlashed] = useState<number | null>(null);
	const captions = useRef<Array<HTMLLIElement | null>>([]);
	const flashTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(flashTimer.current), []);

	const flash = (index: number) => {
		setFlashed(index);
		clearTimeout(flashTimer.current);
		flashTimer.current = setTimeout(() => setFlashed(null), FLASH_MS);
	};
	const isActive = (index: number) => hovered === index || flashed === index;

	return (
		<div className="flex flex-col">
			<div className="relative bg-background p-2.5">
				<div className="relative">
					<img
						alt={props.alt}
						className="block w-full rounded-md border"
						src={props.src}
					/>
					{props.pins.map((pin, index) => {
						const badge = (
							<button
								aria-label={`Pin ${index + 1}`}
								className={cn(
									"-translate-x-1/2 -translate-y-1/2 absolute flex size-[18px] cursor-pointer items-center justify-center rounded-full bg-sky-500 font-semibold text-[10.5px] text-white shadow-[0_0_0_3px_rgb(14_165_233/0.25)] transition-transform",
									isActive(index) &&
										"scale-125 shadow-[0_0_0_4px_rgb(14_165_233/0.45)]",
								)}
								data-text="skip"
								onClick={() => {
									captions.current[index]?.scrollIntoView({
										block: "nearest",
										behavior: "smooth",
									});
									flash(index);
								}}
								onMouseEnter={() => setHovered(index)}
								onMouseLeave={() => setHovered(null)}
								style={
									pin.ring === true
										? {
												left: ringBadgeOffset(pin).dx,
												top: ringBadgeOffset(pin).dy,
											}
										: { left: `${pin.x}%`, top: `${pin.y}%` }
								}
								type="button"
							>
								{index + 1}
							</button>
						);
						if (pin.ring !== true) {
							return <Fragment key={`${pin.x}:${pin.y}`}>{badge}</Fragment>;
						}
						const offset = ringBadgeOffset(pin);
						return (
							<span
								className="absolute size-0"
								data-text="skip"
								key={`${pin.x}:${pin.y}`}
								style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
							>
								<span
									aria-hidden
									className={cn(
										"-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute rounded-full border-2 border-sky-500 shadow-[0_0_0_1px_rgb(255_255_255/0.7)] transition-transform",
										isActive(index) && "scale-125",
									)}
									style={{ width: RING_SIZE, height: RING_SIZE }}
								/>
								<svg
									aria-hidden
									className="pointer-events-none absolute top-0 left-0 overflow-visible"
									height="1"
									width="1"
								>
									<title>leader line</title>
									<line
										className="stroke-sky-500"
										strokeWidth="1.5"
										x1={Math.sign(offset.dx) * (RING_SIZE / 2)}
										x2={offset.dx}
										y1={Math.sign(offset.dy) * (RING_SIZE / 2)}
										y2={offset.dy}
									/>
								</svg>
								{badge}
							</span>
						);
					})}
				</div>
			</div>
			{props.pins.length > 0 && (
				<ol className="m-0 flex list-none flex-col gap-1 border-t p-2.5">
					{props.pins.map((pin, index) => (
						<li
							className={cn(
								"flex items-start gap-2 rounded-md px-1.5 py-0.5 transition-colors",
								isActive(index) && "bg-accent",
							)}
							key={`${pin.x}:${pin.y}`}
							onMouseEnter={() => setHovered(index)}
							onMouseLeave={() => setHovered(null)}
							ref={(element) => {
								captions.current[index] = element;
							}}
						>
							<button
								aria-label={`Highlight pin ${index + 1}`}
								data-text="skip"
								className="mt-0.5 flex size-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full bg-sky-500 font-semibold text-[10.5px] text-white"
								onClick={() => flash(index)}
								type="button"
							>
								{index + 1}
							</button>
							<span className="min-w-0">{pin.children}</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
