"use client";

import { Children, isValidElement, type ReactNode, useState } from "react";

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

/** A screenshot with numbered markers over it and a matching numbered list underneath; hovering either side highlights the other. */
export function PinnedImage(props: {
	src: string;
	alt: string;
	pins: readonly PinProps[];
}): React.ReactElement {
	const [highlighted, setHighlighted] = useState<number | null>(null);
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
						<span
							className={`-translate-x-1/2 -translate-y-1/2 absolute flex size-[18px] items-center justify-center rounded-full bg-sky-500 font-semibold text-[10.5px] text-white shadow-[0_0_0_3px_rgb(14_165_233/0.25)] transition-transform ${highlighted === index ? "scale-125" : ""}`}
							key={`${pin.x}:${pin.y}`}
							style={{ left: `${pin.x}%`, top: `${pin.y}%` }}
						>
							{index + 1}
						</span>
					))}
				</div>
			</div>
			{props.pins.length > 0 && (
				<ol className="flex flex-col gap-1 border-t p-2.5">
					{props.pins.map((pin, index) => (
						<li
							className={`flex items-start gap-2 rounded-md px-1.5 py-0.5 ${highlighted === index ? "bg-accent" : ""}`}
							key={`${pin.x}:${pin.y}`}
							onMouseEnter={() => setHighlighted(index)}
							onMouseLeave={() => setHighlighted(null)}
						>
							<span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full bg-sky-500 font-semibold text-[10.5px] text-white">
								{index + 1}
							</span>
							<span className="min-w-0">{pin.children}</span>
						</li>
					))}
				</ol>
			)}
		</div>
	);
}
