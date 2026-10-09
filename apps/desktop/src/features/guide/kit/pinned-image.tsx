"use client";

import { cn } from "cn";
import {
	Children,
	isValidElement,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";

/** Declarative marker: `Shot` and `Frame` read its props and render it; on its own it draws nothing. `x` and `y` are percentages of the image. */
export function Pin(_props: {
	x: number;
	y: number;
	children?: ReactNode;
}): null {
	return null;
}

type PinProps = { x: number; y: number; children?: ReactNode };

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
					{props.pins.map((pin, index) => (
						<button
							aria-label={`Pin ${index + 1}`}
							className={cn(
								"-translate-x-1/2 -translate-y-1/2 absolute flex size-[18px] cursor-pointer items-center justify-center rounded-full bg-sky-500 font-semibold text-[10.5px] text-white shadow-[0_0_0_3px_rgb(14_165_233/0.25)] transition-transform",
								isActive(index) &&
									"scale-125 shadow-[0_0_0_4px_rgb(14_165_233/0.45)]",
							)}
							key={`${pin.x}:${pin.y}`}
							onClick={() => {
								captions.current[index]?.scrollIntoView({
									block: "nearest",
									behavior: "smooth",
								});
								flash(index);
							}}
							onMouseEnter={() => setHovered(index)}
							onMouseLeave={() => setHovered(null)}
							style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
							type="button"
						>
							{index + 1}
						</button>
					))}
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
