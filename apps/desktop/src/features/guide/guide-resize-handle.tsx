"use client";

import { cn } from "cn";
import { useRef } from "react";
import { Separator } from "react-resizable-panels";
import { Kbd } from "#/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";

/** Pointer travel (px) past which a press counts as a drag, not a click. */
const CLICK_SLOP = 4;

/** How far (px) the hover highlight reaches above and below the pointer before fading out. */
const HIGHLIGHT_REACH = 80;

/**
 * The split handle between the guide and its diff pane, after Linear's
 * sidebar handle: a hairline at rest; on hover a line that is brightest at
 * the pointer's height and fades out above and below, following the pointer
 * along the handle; solid along its whole length while dragging. A click
 * that doesn't drag collapses the pane. The tooltip rides the cursor.
 */
export function GuideResizeHandle(props: {
	onCollapse: () => void;
}): React.ReactElement {
	const line = useRef<HTMLDivElement>(null);

	return (
		// Not `ResizableHandle`: shadcn's wrapper renders its own children in place
		// of the ones it is given.
		<Separator
			className="group/handle relative z-10 w-px bg-border"
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
					"pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 opacity-0 transition-opacity duration-150",
					"[--hl:var(--color-foreground)] [--y:-9999px]",
					"[background:linear-gradient(to_bottom,transparent_calc(var(--y)-var(--reach)),color-mix(in_oklab,var(--hl)_70%,transparent)_var(--y),transparent_calc(var(--y)+var(--reach)))]",
					"group-data-[separator=hover]/handle:opacity-100",
					"group-data-[separator=active]/handle:opacity-100 group-data-[separator=active]/handle:[background:color-mix(in_oklab,var(--hl)_70%,transparent)]",
				)}
				ref={line}
				style={{ "--reach": `${HIGHLIGHT_REACH}px` } as React.CSSProperties}
			/>
		</Separator>
	);
}
