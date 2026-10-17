"use client";

/**
 * The floating "Ask" button for a text selection in the PR description or the
 * guide — `diff-selection-popover.tsx`'s virtual-anchor setup without its
 * copy button (native copy works on prose), wheel forwarding or glide, since
 * the selection lives in the page's own scroll flow rather than a virtualized
 * pane.
 */
import { useLayoutEffect, useState } from "react";
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
	clear: () => void;
};

export function ProseSelectionPopover({
	sessionId,
	orpc,
	reference,
	anchorRect,
	clear,
}: ProseSelectionPopoverProps): React.ReactElement | null {
	const dock = useChatDockActions(sessionId, orpc);

	// Base UI only conceals a popup until it has positioned itself when it sees
	// a real `open: false -> true` edge, and a virtual anchor registers a render
	// late — so open one commit after the reference appears instead of mounting
	// already open (same reasoning as `diff-selection-popover.tsx`).
	const visible = reference !== null && anchorRect !== null;
	const [open, setOpen] = useState(false);
	useLayoutEffect(() => {
		setOpen(visible);
	}, [visible]);

	if (reference === null || anchorRect === null) return null;

	const virtualAnchor = { getBoundingClientRect: () => anchorRect };

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
