"use client";

/**
 * Drag-to-resize mechanics for the floating chat panel (`chat-panel.tsx`),
 * split out because the panel's own file is about chat, not pointer capture
 * and localStorage bookkeeping.
 *
 * The panel is anchored `fixed right-4 bottom-14` — its bottom-right corner
 * never moves, so it can only ever grow up and to the left. That's why every
 * drag delta below is inverted: dragging left (`clientX` decreasing) has to
 * *increase* width, and dragging up (`clientY` decreasing) has to *increase*
 * height — the opposite of a top-left-anchored panel, where the pointer's
 * movement and the dimension's movement point the same way. Three handles
 * follow from that anchor — left edge (width), top edge (height), and the
 * top-left corner (both) — the right and bottom edges are dead ends, since
 * dragging there would just relocate the fixed corner instead of resizing
 * the panel.
 */
import { useCallback, useState } from "react";

const CHAT_PANEL_WIDTH_STORAGE_KEY = "nisi:chat-panel-width";
const CHAT_PANEL_HEIGHT_STORAGE_KEY = "nisi:chat-panel-height";

const CHAT_PANEL_DEFAULT_WIDTH = 360;
const CHAT_PANEL_MIN_WIDTH = 300;
const CHAT_PANEL_MAX_WIDTH = 640;

const CHAT_PANEL_DEFAULT_HEIGHT = 320;
const CHAT_PANEL_MIN_HEIGHT = 200;
const CHAT_PANEL_MAX_HEIGHT = 640;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/** Falls back to `fallback` for a missing or corrupted stored value — mirrors `tab-order.ts`'s `loadTabOrder`. */
function loadChatPanelDimension(
	key: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = localStorage.getItem(key);
	if (raw === null) return fallback;
	const parsed = Number.parseFloat(raw);
	if (Number.isNaN(parsed)) {
		localStorage.removeItem(key);
		return fallback;
	}
	return clamp(parsed, min, max);
}

/** Which dimension(s) a given handle drags — the corner drags both at once. */
type ResizeAxis = "width" | "height" | "both";

type ChatPanelSize = {
	width: number;
	height: number;
	onLeftEdgePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onTopEdgePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onCornerPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
};

/**
 * Dimensions are plain component state during the drag itself; only
 * pointerup writes to `localStorage`, so a fast drag doesn't turn into a
 * flood of synchronous storage writes.
 */
export function useChatPanelSize(): ChatPanelSize {
	const [width, setWidth] = useState(() =>
		loadChatPanelDimension(
			CHAT_PANEL_WIDTH_STORAGE_KEY,
			CHAT_PANEL_DEFAULT_WIDTH,
			CHAT_PANEL_MIN_WIDTH,
			CHAT_PANEL_MAX_WIDTH,
		),
	);
	const [height, setHeight] = useState(() =>
		loadChatPanelDimension(
			CHAT_PANEL_HEIGHT_STORAGE_KEY,
			CHAT_PANEL_DEFAULT_HEIGHT,
			CHAT_PANEL_MIN_HEIGHT,
			CHAT_PANEL_MAX_HEIGHT,
		),
	);

	const startDrag = useCallback(
		(axis: ResizeAxis, event: React.PointerEvent<HTMLDivElement>) => {
			if (event.button !== 0) return;
			event.preventDefault();
			const handle = event.currentTarget;
			handle.setPointerCapture(event.pointerId);
			const startX = event.clientX;
			const startY = event.clientY;
			const startWidth = width;
			const startHeight = height;
			let latestWidth = startWidth;
			let latestHeight = startHeight;

			function handleMove(moveEvent: PointerEvent): void {
				if (axis !== "height") {
					latestWidth = clamp(
						startWidth + (startX - moveEvent.clientX),
						CHAT_PANEL_MIN_WIDTH,
						CHAT_PANEL_MAX_WIDTH,
					);
					setWidth(latestWidth);
				}
				if (axis !== "width") {
					latestHeight = clamp(
						startHeight + (startY - moveEvent.clientY),
						CHAT_PANEL_MIN_HEIGHT,
						CHAT_PANEL_MAX_HEIGHT,
					);
					setHeight(latestHeight);
				}
			}

			function handleEnd(upEvent: PointerEvent): void {
				handle.releasePointerCapture(upEvent.pointerId);
				handle.removeEventListener("pointermove", handleMove);
				handle.removeEventListener("pointerup", handleEnd);
				if (axis !== "height") {
					localStorage.setItem(
						CHAT_PANEL_WIDTH_STORAGE_KEY,
						String(latestWidth),
					);
				}
				if (axis !== "width") {
					localStorage.setItem(
						CHAT_PANEL_HEIGHT_STORAGE_KEY,
						String(latestHeight),
					);
				}
			}

			handle.addEventListener("pointermove", handleMove);
			handle.addEventListener("pointerup", handleEnd);
		},
		[width, height],
	);

	const onLeftEdgePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => startDrag("width", event),
		[startDrag],
	);
	const onTopEdgePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => startDrag("height", event),
		[startDrag],
	);
	const onCornerPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => startDrag("both", event),
		[startDrag],
	);

	return {
		width,
		height,
		onLeftEdgePointerDown,
		onTopEdgePointerDown,
		onCornerPointerDown,
	};
}

type ChatPanelResizeHandlesProps = {
	minimized: boolean;
	onLeftEdgePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onTopEdgePointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onCornerPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
};

/**
 * Invisible hover-discoverable drag zones along the panel's two free edges
 * plus their shared corner — no grip or border, the cursor change alone is
 * the affordance. The corner square sits at a higher z-index than the two
 * strips so it wins the small area where all three overlap, rather than
 * whichever strip happens to paint last. Minimized collapses the panel to
 * just its header, where a height drag would have nothing to resize, so
 * only the left edge (width) renders then — width still applies and
 * persists for when the panel reopens.
 */
export function ChatPanelResizeHandles({
	minimized,
	onLeftEdgePointerDown,
	onTopEdgePointerDown,
	onCornerPointerDown,
}: ChatPanelResizeHandlesProps): React.ReactElement {
	return (
		<>
			<div
				className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize"
				onPointerDown={onLeftEdgePointerDown}
			/>
			{!minimized && (
				<>
					<div
						className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-ns-resize"
						onPointerDown={onTopEdgePointerDown}
					/>
					<div
						className="absolute top-0 left-0 z-20 size-3.5 cursor-nwse-resize"
						onPointerDown={onCornerPointerDown}
					/>
				</>
			)}
		</>
	);
}
