import { useCallback, useRef, useState } from "react";

type ScrollMemory = { scrollTop: number; stuckToBottom: boolean };

/** Module scope, not zustand: saving on every scroll event must not render anything. */
const scrollMemory = new Map<string, ScrollMemory>();

/** Distance from the bottom within which the view counts as "at the bottom". */
const STICK_THRESHOLD_PX = 8;

/** Drops a thread's saved scroll position — call wherever its `Chat` instance is disposed. */
export function forgetChatScroll(threadId: string): void {
	scrollMemory.delete(threadId);
}

function distanceFromBottom(viewport: HTMLElement): number {
	return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
}

export type ChatScroll = {
	/** Pass to `ScrollArea`'s `viewportRef`. Re-runs setup whenever `threadId` changes. */
	viewportRef: (viewport: HTMLDivElement | null) => void;
	/** False once the user has scrolled away from the bottom; drives the jump-to-latest button. */
	stuckToBottom: boolean;
	/** Re-sticks to the bottom and scrolls there. */
	scrollToEnd: (behavior?: ScrollBehavior) => void;
};

/**
 * Pins a message list to its bottom while the user hasn't scrolled away, and
 * remembers each thread's position across thread switches and popup
 * close/reopen.
 *
 * Everything hangs off a callback ref rather than an effect so setup runs in
 * the commit phase, before paint (no visible jump to the bottom), and so it
 * also re-runs when the viewport remounts, which it does on every
 * popup close/reopen.
 *
 * Programmatic vs user scrolls: we only ever scroll *down* (to the bottom), and
 * content growth never moves `scrollTop` at all. So a scroll event that moves
 * `scrollTop` up and lands past the threshold is the user; anything else
 * (our own pin, the browser clamping after content shrinks) cannot release
 * the stick. This also covers scrollbar drags, which wheel/touch/key
 * listeners would miss.
 */
export function useChatScroll(threadId: string): ChatScroll {
	const [stuckToBottom, setStuckToBottom] = useState(true);
	const viewportElement = useRef<HTMLDivElement | null>(null);
	const stuck = useRef(true);

	const setStuck = useCallback((next: boolean) => {
		stuck.current = next;
		setStuckToBottom(next);
	}, []);

	const viewportRef = useCallback(
		(viewport: HTMLDivElement | null) => {
			if (viewport === null) return;
			viewportElement.current = viewport;

			const saved = scrollMemory.get(threadId);
			if (saved !== undefined && !saved.stuckToBottom) {
				setStuck(false);
				viewport.scrollTop = saved.scrollTop;
			} else {
				setStuck(true);
				viewport.scrollTop = viewport.scrollHeight;
			}
			const tracking = { lastTop: viewport.scrollTop };

			const onScroll = () => {
				const top = viewport.scrollTop;
				const movedUp = top < tracking.lastTop;
				tracking.lastTop = top;

				if (distanceFromBottom(viewport) <= STICK_THRESHOLD_PX) {
					setStuck(true);
				} else if (movedUp) {
					setStuck(false);
				}
				scrollMemory.set(threadId, {
					scrollTop: top,
					stuckToBottom: stuck.current,
				});
			};
			viewport.addEventListener("scroll", onScroll, { passive: true });

			const pinIfStuck = () => {
				if (!stuck.current) return;
				viewport.scrollTop = viewport.scrollHeight;
				tracking.lastTop = viewport.scrollTop;
			};
			const observer = new ResizeObserver(pinIfStuck);
			// The viewport's own size changes with the panel's resize handles; the
			// content's with streaming text and expanding trace groups.
			observer.observe(viewport);
			const content = viewport.querySelector(
				'[data-slot="scroll-area-content"]',
			);
			if (content !== null) observer.observe(content);

			return () => {
				viewport.removeEventListener("scroll", onScroll);
				observer.disconnect();
				if (viewportElement.current === viewport) {
					viewportElement.current = null;
				}
			};
		},
		[threadId, setStuck],
	);

	const scrollToEnd = useCallback(
		(behavior: ScrollBehavior = "instant") => {
			const viewport = viewportElement.current;
			if (viewport === null) return;
			setStuck(true);
			viewport.scrollTo({ top: viewport.scrollHeight, behavior });
		},
		[setStuck],
	);

	return { viewportRef, stuckToBottom, scrollToEnd };
}
