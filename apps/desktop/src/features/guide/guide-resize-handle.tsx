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

/** A bell-shaped falloff, in (distance from the pointer as a share of the reach, opacity) pairs, so the line fades over a long stretch instead of cutting off in a short bright spot. */
const FALLOFF: readonly (readonly [number, number])[] = [
	[1, 0],
	[0.8, 0.08],
	[0.6, 0.28],
	[0.4, 0.58],
	[0.2, 0.86],
	[0, 1],
];

function highlightStop(signedDistance: number, opacity: number): string {
	return `rgb(0 0 0 / ${opacity}) calc(var(--y) + ${Math.round(signedDistance * HIGHLIGHT_REACH)}px)`;
}

/** An alpha mask over the card-shaped overlay: the border color shows only near the pointer. */
const HIGHLIGHT_MASK = `linear-gradient(to bottom, ${[
	...FALLOFF.map(([distance, opacity]) => highlightStop(-distance, opacity)),
	...[...FALLOFF]
		.reverse()
		.slice(1)
		.map(([distance, opacity]) => highlightStop(distance, opacity)),
].join(", ")})`;

/** The pane's cards: each file's `<diffs-container>` host, and the toolbar card. */
const CARD_SELECTOR = "diffs-container, [data-diff-pane-card]";

/** How far (px) inside the card's left border the probe for "which card is here" is taken. */
const CARD_PROBE_INSET = 4;

/** `card`'s vertical extent, cut to what its scrolling ancestors actually show. */
function visibleSpan(card: Element): { top: number; bottom: number } {
	const rect = card.getBoundingClientRect();
	let top = rect.top;
	let bottom = rect.bottom;
	for (
		let ancestor = card.parentElement;
		ancestor !== null;
		ancestor = ancestor.parentElement
	) {
		if (getComputedStyle(ancestor).overflowY === "visible") continue;
		const bounds = ancestor.getBoundingClientRect();
		top = Math.max(top, bounds.top);
		bottom = Math.min(bottom, bounds.bottom);
	}
	return { top, bottom };
}

/**
 * The split handle between the guide and its diff pane, after Linear's
 * sidebar handle. It draws nothing at rest. The pane's cards sit
 * `--spacing-diff-pane-inset` in from the panel boundary (the toolbar's margin
 * and `DiffCodeView`'s padding read the same token), so the handle is centred
 * in that gap with an invisible hit area that stops at the card border and
 * never covers a card. On hover a 1px line lights the straight
 * part of the border of the card under the pointer (it stops where the corner
 * rounds), brightest at the pointer's height and fading out above and below
 * along a fixed spread as the pointer moves; it stays lit along that segment
 * while dragging. A click that doesn't drag collapses the pane.
 * The tooltip rides the cursor.
 */
export function GuideResizeHandle(props: {
	onCollapse: () => void;
}): React.ReactElement {
	const line = useRef<HTMLDivElement>(null);
	const hitArea = useRef<HTMLDivElement>(null);

	/** Lights the border of the card at `clientY` only, with the gradient centred on the pointer. Between cards it hides, or with `keepLast` (while dragging) stays on the last card. */
	const lightCardAt = (clientY: number, keepLast: boolean) => {
		const glow = line.current;
		const separator = glow?.parentElement;
		const hit = hitArea.current;
		if (glow == null || separator == null || hit == null) return;
		const separatorRect = separator.getBoundingClientRect();
		const card = document
			.elementsFromPoint(
				hit.getBoundingClientRect().right + CARD_PROBE_INSET,
				clientY,
			)
			.find((element) => element.matches(CARD_SELECTOR));
		if (card === undefined) {
			if (!keepLast) glow.style.visibility = "hidden";
			return;
		}
		const rect = card.getBoundingClientRect();
		const visible = visibleSpan(card);
		// The straight part of the edge only: it stops where the corner starts to round.
		const radius = Number.parseFloat(
			getComputedStyle(glow).borderTopLeftRadius,
		);
		const top = Math.max(rect.top + radius, visible.top);
		const bottom = Math.min(rect.bottom - radius, visible.bottom);
		if (bottom <= top) {
			glow.style.visibility = "hidden";
			return;
		}
		glow.style.left = `${rect.left - separatorRect.left}px`;
		glow.style.top = `${top - separatorRect.top}px`;
		glow.style.height = `${bottom - top}px`;
		// Measured from the pointer, never from the card: the line's ends only clip
		// the gradient, so the peak keeps following the pointer up to either end.
		glow.style.setProperty("--y", `${clientY - top}px`);
		glow.style.visibility = "visible";
	};

	return (
		// Not `ResizableHandle`: shadcn's wrapper renders its own children in place
		// of the ones it is given.
		<Separator
			className="group/handle relative z-10 w-0 translate-x-[calc(var(--spacing-diff-pane-inset)/2)]"
			disableDoubleClick
		>
			<Tooltip trackCursorAxis="both">
				<TooltipTrigger
					render={
						<div
							className="absolute inset-y-0 -left-[calc(var(--spacing-diff-pane-inset)/2)] w-[calc(var(--spacing-diff-pane-inset)+1px)]"
							onPointerDown={(event) => {
								const startX = event.clientX;
								const startY = event.clientY;
								const follow = (moveEvent: PointerEvent) =>
									lightCardAt(moveEvent.clientY, true);
								window.addEventListener("pointermove", follow);
								window.addEventListener(
									"pointerup",
									(upEvent) => {
										window.removeEventListener("pointermove", follow);
										const travelled = Math.hypot(
											upEvent.clientX - startX,
											upEvent.clientY - startY,
										);
										if (travelled < CLICK_SLOP) props.onCollapse();
									},
									{ once: true },
								);
							}}
							onPointerMove={(event) => lightCardAt(event.clientY, false)}
							ref={hitArea}
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
					// `rounded-xl` is only read, for the cards' corner radius (`--radius-xl`).
					"pointer-events-none invisible absolute w-px rounded-xl bg-muted-foreground opacity-0 transition-opacity duration-150",
					"[--y:-9999px] [mask-image:var(--highlight)]",
					"group-data-[separator=hover]/handle:opacity-100",
					"group-data-[separator=active]/handle:opacity-100 group-data-[separator=active]/handle:[mask-image:none]",
				)}
				ref={line}
				style={{ "--highlight": HIGHLIGHT_MASK } as React.CSSProperties}
			/>
		</Separator>
	);
}
