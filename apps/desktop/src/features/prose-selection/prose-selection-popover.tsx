"use client";

/**
 * The floating "Ask" button for a text selection in the PR description or the
 * guide — `diff-selection-popover.tsx`'s virtual-anchor setup without its
 * copy button (native copy works on prose), wheel forwarding or glide, since
 * the selection lives in the page's own scroll flow rather than a virtualized
 * pane.
 */
import { type RefObject, useLayoutEffect, useState } from "react";
import { Button } from "#/components/ui/button";
import { Popover, PopoverPrimitive } from "#/components/ui/popover";
import { Toolbar, ToolbarButton } from "#/components/ui/toolbar";
import type { ExcerptReference } from "#/features/chat/chat-reference";
import { useChatDockActions } from "#/features/chat/chat-store";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { proseSelectionPopupMarkerProps } from "./use-prose-selection";

type ProseSelectionPopoverProps = {
	/** Which PR tab's chat threads "Ask" attaches the excerpt to — see `useChatDockActions`. */
	sessionId: string;
	orpc: SidecarQueryUtils;
	reference: ExcerptReference | null;
	anchorRect: DOMRect | null;
	/** The element the selection scrolls inside: the popover hides when the selection leaves it and stays within its bounds. */
	scroller: RefObject<HTMLElement | null>;
	clear: () => void;
};

/** The part of `anchor` inside `boundary`, collapsed to its bottom edge; `null` when none of it is visible. */
function clampToBoundary(anchor: DOMRect, boundary: DOMRect): DOMRect | null {
	const visible =
		anchor.bottom > boundary.top &&
		anchor.top < boundary.bottom &&
		anchor.right > boundary.left &&
		anchor.left < boundary.right;
	if (!visible) return null;
	const left = Math.max(anchor.left, boundary.left);
	return new DOMRect(
		left,
		Math.min(anchor.bottom, boundary.bottom),
		Math.min(anchor.right, boundary.right) - left,
		0,
	);
}

export function ProseSelectionPopover({
	sessionId,
	orpc,
	reference,
	anchorRect,
	scroller,
	clear,
}: ProseSelectionPopoverProps): React.ReactElement | null {
	const dock = useChatDockActions(sessionId, orpc);

	// Base UI only conceals a popup until it has positioned itself when it sees
	// a real `open: false -> true` edge, and a virtual anchor registers a render
	// late — so open one commit after the reference appears instead of mounting
	// already open (same reasoning as `diff-selection-popover.tsx`).
	const scrollerElement = scroller.current;
	// Base UI's hide middleware only looks at the portaled positioner's own
	// clipping ancestors, so it can't hide an anchor scrolled out of `scroller`.
	const boundary = scrollerElement?.getBoundingClientRect();
	const visibleAnchor =
		anchorRect !== null && boundary !== undefined
			? clampToBoundary(anchorRect, boundary)
			: null;
	const visible = reference !== null && visibleAnchor !== null;
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		setOpen(visible);
	}, [visible]);

	if (reference === null || visibleAnchor === null) return null;

	const virtualAnchor = { getBoundingClientRect: () => visibleAnchor };

	return (
		<Popover
			onOpenChange={(_open, eventDetails) => {
				if (eventDetails.reason === "escape-key") clear();
			}}
			open={open}
		>
			<PopoverPrimitive.Portal>
				<PopoverPrimitive.Positioner
					align="start"
					anchor={virtualAnchor}
					className="z-50 outline-none"
					collisionBoundary={scrollerElement ?? undefined}
					side="bottom"
					sideOffset={8}
				>
					<PopoverPrimitive.Popup
						className="outline-none"
						data-slot="popover-popup"
						finalFocus={false}
						// Keeps the click on "Ask" from collapsing the selection before
						// the click handler runs.
						onMouseDown={(event) => event.preventDefault()}
						{...proseSelectionPopupMarkerProps}
					>
						<Toolbar>
							<ToolbarButton
								onClick={() => {
									dock.askWithReference(reference);
									clear();
								}}
								render={<Button size="xs" variant="ghost" />}
							>
								Ask
							</ToolbarButton>
						</Toolbar>
					</PopoverPrimitive.Popup>
				</PopoverPrimitive.Positioner>
			</PopoverPrimitive.Portal>
		</Popover>
	);
}
