"use client";

/**
 * Scrolls the diff pane's scroll container while a selection drag — gutter
 * or text, `use-diff-selection.ts`'s two selection sources — is in progress
 * and the pointer is near or past the container's top or bottom edge. Kept
 * out of `use-diff-selection.ts` on purpose: that file already carries two
 * selection sources' worth of state and lifecycle, and "scroll the container
 * while a drag is near the edge" is a separate concern with its own
 * start/stop lifecycle, not another selection source. This hook has no idea
 * whether a selection actually exists and doesn't need to — a pointer that
 * went down inside the diff and hasn't come back up yet is enough to arm it;
 * nothing happens unless that pointer is also near an edge.
 *
 * A container scroll alone doesn't extend either selection mechanism, since
 * both only (re-)resolve which row the pointer is over from a move event,
 * never from a scroll event: `@pierre/diffs`' `InteractionManager` tracks an
 * in-progress gutter drag via its own `document`-level `pointermove`
 * listener, hit-testing `event.clientX`/`clientY` through
 * `elementFromPoint` on each move (confirmed in
 * `InteractionManager.js`'s `handleDocumentPointerMove` /
 * `pathFromCoordinates` — no `setPointerCapture`, no auto-scroll option of
 * its own to opt into instead); a native text-selection drag extends off
 * the browser's own `mousemove`-driven default action the same way. Either
 * way, a pointer that hasn't physically moved never tells either mechanism
 * "the row under you just changed" just because the content scrolled past
 * it. Each scroll step re-dispatches a synthetic pointer/mouse move at the
 * same client coordinates the real pointer last reported — exactly what a
 * real move at that same screen position would carry — so both mechanisms
 * re-resolve against whatever row is actually under the cursor now.
 * `pointermove` alone only reaches `@pierre/diffs`' listener: Chromium only
 * synthesizes a compatibility `mousemove` from a *trusted* pointer event,
 * never from one built via `dispatchEvent`, so the native text-selection
 * path needs its own explicit `mousemove` dispatch alongside it.
 */
import { useEffect, useRef } from "react";

type UseDragAutoscrollOptions = {
	/** Reach the diff pane's scroll container fresh on every check, the same way `diff-pane.tsx` itself does (`codeViewRef.current?.getInstance()?.getContainerElement()`) — it isn't mounted until `@pierre/diffs` has rendered at least one file, and this hook may be armed before or after that happens. */
	getScrollContainer: () => HTMLElement | null | undefined;
};

/** Inward from each edge, in px, where the pointer already counts as "near the edge" and scrolling starts — the zone begins slightly inside the container, not only once the pointer has left it. */
const EDGE_ACTIVATION_ZONE = 56;
/** How far past `EDGE_ACTIVATION_ZONE`'s inner boundary (in px, still inside the container or already past its bounds) scroll speed reaches its max. */
const MAX_EDGE_DISTANCE = 150;
const MIN_SCROLL_SPEED = 4;
const MAX_SCROLL_SPEED = 28;

/** Linear ramp from `MIN_SCROLL_SPEED` at the activation boundary to `MAX_SCROLL_SPEED` by `MAX_EDGE_DISTANCE` past it; `0` before the boundary. */
function scrollSpeedForDistance(distancePastBoundary: number): number {
	if (distancePastBoundary <= 0) return 0;
	const t =
		Math.min(distancePastBoundary, MAX_EDGE_DISTANCE) / MAX_EDGE_DISTANCE;
	return MIN_SCROLL_SPEED + t * (MAX_SCROLL_SPEED - MIN_SCROLL_SPEED);
}

/** How much to scroll `container` this tick for a pointer currently at `clientY` — signed, negative is up — `0` when `clientY` isn't within either edge's activation zone. */
function resolveAutoscrollDelta(rect: DOMRect, clientY: number): number {
	const upSpeed = scrollSpeedForDistance(
		rect.top + EDGE_ACTIVATION_ZONE - clientY,
	);
	const downSpeed = scrollSpeedForDistance(
		clientY - (rect.bottom - EDGE_ACTIVATION_ZONE),
	);
	if (downSpeed >= upSpeed && downSpeed > 0) return downSpeed;
	if (upSpeed > 0) return -upSpeed;
	return 0;
}

/**
 * Whether `event`'s true origin (not its retargeted `.target` — see
 * `use-diff-selection.ts`'s `isEventOriginOnGutter` doc comment for why
 * `composedPath()` is what survives shadow-root retargeting) is inside
 * `container`.
 */
function isEventOriginInside(event: Event, container: HTMLElement): boolean {
	for (const node of event.composedPath()) {
		if (node === container) return true;
	}
	return false;
}

/** Re-dispatches a pointer/mouse move at `clientX`/`clientY` — see this file's doc comment for why both event types and why this is what makes a scroll step actually extend either selection mechanism. */
function redispatchMoveAt(
	clientX: number,
	clientY: number,
	pointerId: number,
): void {
	const shared = {
		clientX,
		clientY,
		bubbles: true,
		cancelable: true,
		composed: true,
	};
	document.dispatchEvent(
		new PointerEvent("pointermove", {
			...shared,
			pointerId,
			pointerType: "mouse",
			isPrimary: true,
		}),
	);
	document.dispatchEvent(
		new MouseEvent("mousemove", { ...shared, button: 0, buttons: 1 }),
	);
}

export function useDragAutoscroll({
	getScrollContainer,
}: UseDragAutoscrollOptions): void {
	// Read through a ref so the effect below never has to tear down and
	// re-attach its `document` listeners just because the caller passed a new
	// closure — this hook's own identity should track nothing but mount.
	const getScrollContainerRef = useRef(getScrollContainer);
	getScrollContainerRef.current = getScrollContainer;

	useEffect(() => {
		// `null` means no drag is in progress — every handler below gates on
		// this first, and the scroll loop stops itself the tick after it goes
		// back to `null`.
		let draggingPointerId: number | null = null;
		let lastClientX = 0;
		let lastClientY = 0;
		let animationFrame: number | null = null;

		const stopScrollLoop = () => {
			if (animationFrame !== null) {
				cancelAnimationFrame(animationFrame);
				animationFrame = null;
			}
		};

		const scrollLoopTick = () => {
			animationFrame = null;
			if (draggingPointerId === null) return;
			const container = getScrollContainerRef.current();
			if (container) {
				const delta = resolveAutoscrollDelta(
					container.getBoundingClientRect(),
					lastClientY,
				);
				if (delta !== 0) {
					const before = container.scrollTop;
					container.scrollTop = before + delta;
					// Already at the scroll boundary — nothing moved, so nothing for
					// either selection mechanism to re-resolve against.
					if (container.scrollTop !== before) {
						redispatchMoveAt(lastClientX, lastClientY, draggingPointerId);
					}
				}
			}
			animationFrame = requestAnimationFrame(scrollLoopTick);
		};

		const handlePointerDown = (event: PointerEvent) => {
			if (event.pointerType === "mouse" && event.button !== 0) return;
			const container = getScrollContainerRef.current();
			if (!container || !isEventOriginInside(event, container)) return;
			draggingPointerId = event.pointerId;
			lastClientX = event.clientX;
			lastClientY = event.clientY;
			stopScrollLoop();
			animationFrame = requestAnimationFrame(scrollLoopTick);
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (event.pointerId !== draggingPointerId) return;
			lastClientX = event.clientX;
			lastClientY = event.clientY;
		};

		const stopDragging = (event: PointerEvent) => {
			if (event.pointerId !== draggingPointerId) return;
			draggingPointerId = null;
			stopScrollLoop();
		};

		document.addEventListener("pointerdown", handlePointerDown, {
			passive: true,
		});
		document.addEventListener("pointermove", handlePointerMove, {
			passive: true,
		});
		document.addEventListener("pointerup", stopDragging, { passive: true });
		document.addEventListener("pointercancel", stopDragging, {
			passive: true,
		});
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown);
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", stopDragging);
			document.removeEventListener("pointercancel", stopDragging);
			stopScrollLoop();
		};
	}, []);
}
