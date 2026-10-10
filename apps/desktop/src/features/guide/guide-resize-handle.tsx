"use client";

import { cn } from "cn";
import { useRef } from "react";
import { Separator } from "react-resizable-panels";
import { Kbd } from "#/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";

/** Pointer travel (px) past which a press counts as a drag, not a click. */
const CLICK_SLOP = 4;

/** How far (px) the hover highlight reaches above and below the pointer before it has fully faded. */
const HIGHLIGHT_REACH = 360;

/** Share of the foreground color at the pointer's height. */
const HIGHLIGHT_PEAK = 0.22;

/** A bell-shaped falloff, in (distance from the pointer as a share of the reach, share of the peak) pairs, so the line fades over a long stretch instead of cutting off in a short bright spot. */
const FALLOFF: readonly (readonly [number, number])[] = [
	[1, 0],
	[0.8, 0.06],
	[0.6, 0.22],
	[0.4, 0.5],
	[0.2, 0.82],
	[0, 1],
];

function highlightStop(signedDistance: number, share: number): string {
	const color = `color-mix(in oklab, var(--hl) ${(share * HIGHLIGHT_PEAK * 100).toFixed(2)}%, transparent)`;
	return `${color} calc(var(--y) + ${Math.round(signedDistance * HIGHLIGHT_REACH)}px)`;
}

const HIGHLIGHT_GRADIENT = `linear-gradient(to bottom, ${[
	...FALLOFF.map(([distance, share]) => highlightStop(-distance, share)),
	...[...FALLOFF]
		.reverse()
		.slice(1)
		.map(([distance, share]) => highlightStop(distance, share)),
].join(", ")})`;

/**
 * The split handle between the guide and its diff pane, after Linear's
 * sidebar handle. It draws nothing at rest. It sits along the left edge of
 * the pane's cards (the toolbar card's `mx-3` and `DiffCodeView`'s `px-3`
 * inset them 12px from the panel boundary, hence `translate-x-3`), with a wide
 * invisible hit area. On hover a highlight is drawn over the cards' own
 * border line, brightest at the pointer's height and fading out above and
 * below as the pointer moves; it stays lit along the whole edge while
 * dragging. A click that doesn't drag collapses the pane. The tooltip rides
 * the cursor.
 */
export function GuideResizeHandle(props: {
	onCollapse: () => void;
}): React.ReactElement {
	const line = useRef<HTMLDivElement>(null);

	return (
		// Not `ResizableHandle`: shadcn's wrapper renders its own children in place
		// of the ones it is given.
		<Separator
			className="group/handle relative z-10 w-0 translate-x-3"
			disableDoubleClick
		>
			<Tooltip trackCursorAxis="both">
				<TooltipTrigger
					render={
						<div
							className="absolute inset-y-0 -left-1.5 w-3 cursor-col-resize"
							onPointerDown={(event) => {
								const startX = event.clientX;
								const startY = event.clientY;
								window.addEventListener(
									"pointerup",
									(upEvent) => {
										const travelled = Math.hypot(
											upEvent.clientX - startX,
											upEvent.clientY - startY,
										);
										if (travelled < CLICK_SLOP) props.onCollapse();
									},
									{ once: true },
								);
							}}
							onPointerMove={(event) => {
								const bounds = event.currentTarget.getBoundingClientRect();
								line.current?.style.setProperty(
									"--y",
									`${event.clientY - bounds.top}px`,
								);
							}}
						/>
					}
				/>
				<TooltipPopup align="start" side="right" sideOffset={12}>
					<span className="flex flex-col gap-0.5 py-0.5">
						<span>
							<strong className="font-semibold">Drag</strong> to resize
						</span>
						<span className="flex items-center gap-1.5">
							<span>
								<strong className="font-semibold">Click</strong> to collapse
							</span>
							<Kbd>Esc</Kbd>
						</span>
					</span>
				</TooltipPopup>
			</Tooltip>
			<div
				aria-hidden
				className={cn(
					"pointer-events-none absolute inset-y-0 left-0 w-px opacity-0 transition-opacity duration-150",
					"[--hl:var(--color-foreground)] [--y:-9999px]",
					"[background:var(--highlight)]",
					"group-data-[separator=hover]/handle:opacity-100",
					"group-data-[separator=active]/handle:opacity-100 group-data-[separator=active]/handle:[background:color-mix(in_oklab,var(--hl)_45%,transparent)]",
				)}
				ref={line}
				style={{ "--highlight": HIGHLIGHT_GRADIENT } as React.CSSProperties}
			/>
		</Separator>
	);
}
