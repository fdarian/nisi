import { cn } from "cn";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
	type MouseEvent,
	type RefCallback,
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

/**
 * Fluid hover (https://www.fluidfunctionalism.com/docs/fluid-hover): one
 * highlight follows the pointer to the item nearest it and glides between
 * items. A trimmed port of the registry's `useFluidHover` — no gap-click
 * routing, and rects are read at pointer time instead of cached, since a tab
 * strip reorders and resizes under it.
 */

type Rect = { left: number; top: number; width: number; height: number };

type Highlight = {
	rect: Rect | null;
	/** The rect changed because the content scrolled; the highlight must track it without easing. */
	scrolled: boolean;
	/** Steps on each pointer entry so the highlight fades in at the new item instead of sliding from the last one. */
	session: number;
};

/** What `FluidHoverHighlight` subscribes to; hover changes re-render it, never the hook's host. */
type HighlightSource = {
	subscribe: (listener: () => void) => () => void;
	getSnapshot: () => Highlight;
};

type FluidHover<T extends HTMLElement> = {
	containerRef: RefObject<T | null>;
	handlers: {
		onMouseEnter: () => void;
		onMouseLeave: () => void;
		onMouseMove: (event: MouseEvent) => void;
	};
	/** Ref callback for each hoverable item; items may mount in any order. */
	registerItem: RefCallback<HTMLElement>;
	/**
	 * Re-measures the lit item without re-picking, so the highlight rides the
	 * content while it scrolls. For scrolls the hook can't see (e.g. inside a
	 * shadow root). Hides the highlight if the item is gone.
	 */
	follow: () => void;
	highlight: HighlightSource;
};

function measure(element: HTMLElement, container: HTMLElement): Rect {
	const box = element.getBoundingClientRect();
	const containerBox = container.getBoundingClientRect();
	return {
		left: box.left - containerBox.left - container.clientLeft,
		top: box.top - containerBox.top - container.clientTop,
		width: box.width,
		height: box.height,
	};
}

/** The item the pointer is inside, else the one whose center is nearest on `axis`. */
function pickNearest(
	items: ReadonlySet<HTMLElement>,
	axis: "x" | "y",
	pointer: Pointer,
): HTMLElement | null {
	let nearest: HTMLElement | null = null;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (const element of items) {
		const box = element.getBoundingClientRect();
		const inside =
			pointer.x >= box.left &&
			pointer.x <= box.right &&
			pointer.y >= box.top &&
			pointer.y <= box.bottom;
		if (inside) return element;
		const distance =
			axis === "x"
				? Math.abs(pointer.x - (box.left + box.width / 2))
				: Math.abs(pointer.y - (box.top + box.height / 2));
		if (distance < nearestDistance) {
			nearest = element;
			nearestDistance = distance;
		}
	}
	return nearest;
}

function sameRect(a: Rect, b: Rect): boolean {
	return (
		a.left === b.left &&
		a.top === b.top &&
		a.width === b.width &&
		a.height === b.height
	);
}

/** Set on the lit item, so its descendants can restyle themselves (`group-data-[fluid-hover-active]/…`). */
const ACTIVE_ATTR = "data-fluid-hover-active";

type Pointer = { x: number; y: number };

function createHighlightStore() {
	let snapshot: Highlight = { rect: null, scrolled: false, session: 0 };
	let lit: HTMLElement | null = null;
	const listeners = new Set<() => void>();

	const publish = (next: Highlight) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};

	const light = (element: HTMLElement | null) => {
		if (lit === element) return;
		lit?.removeAttribute(ACTIVE_ATTR);
		element?.setAttribute(ACTIVE_ATTR, "");
		lit = element;
	};

	const source: HighlightSource = {
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
	};

	return {
		source,
		show: (
			element: HTMLElement,
			rect: Rect,
			options: { scrolled: boolean; newSession: boolean },
		) => {
			const unchanged =
				!options.newSession &&
				lit === element &&
				snapshot.rect !== null &&
				sameRect(snapshot.rect, rect);
			if (unchanged) return;
			light(element);
			publish({
				rect,
				scrolled: options.scrolled,
				session: snapshot.session + (options.newSession ? 1 : 0),
			});
		},
		hide: () => {
			light(null);
			if (snapshot.rect === null) return;
			publish({ rect: null, scrolled: false, session: snapshot.session });
		},
	};
}

type FluidHoverOptions = {
	/** Replaces the registry lookup for items the hook can't register as refs. Must be stable; returning null keeps the current item. */
	resolveItem?: (pointer: Pointer) => HTMLElement | null;
	/**
	 * Re-finds the lit item while following a scroll, for hosts that recycle
	 * item elements across content so `previous` may now show something else.
	 * Must be stable; null means the item is gone.
	 */
	reacquireItem?: (previous: HTMLElement) => HTMLElement | null;
};

/** `containerRef` must sit on a `relative` element that contains every registered item. */
export function useFluidHover<T extends HTMLElement>(
	axis: "x" | "y",
	options?: FluidHoverOptions,
): FluidHover<T> {
	const resolveItem = options?.resolveItem;
	const reacquireItem = options?.reacquireItem;
	const containerRef = useRef<T | null>(null);
	const itemsRef = useRef(new Set<HTMLElement>());
	const frameRef = useRef<number | null>(null);
	const followFrameRef = useRef<number | null>(null);
	const pointerRef = useRef<Pointer | null>(null);
	const sessionPendingRef = useRef(false);
	const activeElementRef = useRef<HTMLElement | null>(null);
	const [store] = useState(createHighlightStore);

	const cancelFrame = useCallback(() => {
		if (frameRef.current !== null) {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = null;
		}
		if (followFrameRef.current !== null) {
			cancelAnimationFrame(followFrameRef.current);
			followFrameRef.current = null;
		}
	}, []);

	const pick = useCallback(() => {
		frameRef.current = null;
		const container = containerRef.current;
		const pointer = pointerRef.current;
		if (container === null || pointer === null) return;
		const element =
			resolveItem === undefined
				? pickNearest(itemsRef.current, axis, pointer)
				: resolveItem(pointer);
		if (element === null) return;
		const newSession =
			sessionPendingRef.current && element !== activeElementRef.current;
		if (newSession) sessionPendingRef.current = false;
		activeElementRef.current = element;
		store.show(element, measure(element, container), {
			scrolled: false,
			newSession,
		});
	}, [axis, resolveItem, store]);

	const followScroll = useCallback(() => {
		followFrameRef.current = null;
		const container = containerRef.current;
		const previous = activeElementRef.current;
		if (container === null || previous === null) return;
		const element =
			reacquireItem === undefined
				? previous.isConnected
					? previous
					: null
				: reacquireItem(previous);
		activeElementRef.current = element;
		if (element === null) {
			store.hide();
			return;
		}
		store.show(element, measure(element, container), {
			scrolled: true,
			newSession: false,
		});
	}, [reacquireItem, store]);

	/** A pick already pending measures the item itself, so a follow would only race it. */
	const follow = useCallback(() => {
		if (frameRef.current !== null || followFrameRef.current !== null) return;
		followFrameRef.current = requestAnimationFrame(followScroll);
	}, [followScroll]);

	/** Re-picks from the last pointer position, which a layout shift can leave under a different item without a `mousemove`. */
	const schedulePick = useCallback(() => {
		cancelFrame();
		frameRef.current = requestAnimationFrame(pick);
	}, [cancelFrame, pick]);

	const registerItem = useCallback(
		(element: HTMLElement | null) => {
			if (element === null) return;
			itemsRef.current.add(element);
			return () => {
				itemsRef.current.delete(element);
				if (activeElementRef.current === element) {
					activeElementRef.current = null;
					store.hide();
					schedulePick();
				}
			};
		},
		[schedulePick, store],
	);

	const onMouseMove = useCallback(
		(event: MouseEvent) => {
			pointerRef.current = { x: event.clientX, y: event.clientY };
			schedulePick();
		},
		[schedulePick],
	);

	const onMouseEnter = useCallback(() => {
		sessionPendingRef.current = true;
	}, []);

	const onMouseLeave = useCallback(() => {
		cancelFrame();
		pointerRef.current = null;
		activeElementRef.current = null;
		store.hide();
	}, [cancelFrame, store]);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		const observer = new ResizeObserver(schedulePick);
		observer.observe(container);
		// Capture: scroll events don't bubble, and the scroller is an ancestor of the container.
		window.addEventListener("scroll", follow, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", follow, true);
		};
	}, [schedulePick, follow]);

	useEffect(() => cancelFrame, [cancelFrame]);
	useEffect(() => store.hide, [store]);

	return {
		containerRef,
		handlers: { onMouseEnter, onMouseLeave, onMouseMove },
		registerItem,
		follow,
		highlight: store.source,
	};
}

const MOVE_SPRING = { type: "spring", duration: 0.08, bounce: 0 } as const;

export function FluidHoverHighlight(props: {
	className?: string;
	hidden?: boolean;
	hover: Pick<FluidHover<HTMLElement>, "highlight">;
}): React.ReactElement {
	const reducedMotion = useReducedMotion();
	const highlight = useSyncExternalStore(
		props.hover.highlight.subscribe,
		props.hover.highlight.getSnapshot,
	);
	const rect = props.hidden ? null : highlight.rect;
	return (
		<AnimatePresence>
			{rect !== null && (
				<motion.div
					animate={{
						opacity: 1,
						x: rect.left,
						y: rect.top,
						width: rect.width,
						height: rect.height,
					}}
					className={cn(
						"pointer-events-none absolute top-0 left-0",
						props.className,
					)}
					exit={{ opacity: 0, transition: { duration: 0.06 } }}
					initial={{
						opacity: 0,
						x: rect.left,
						y: rect.top,
						width: rect.width,
						height: rect.height,
					}}
					key={highlight.session}
					transition={{
						...(reducedMotion ? { duration: 0 } : MOVE_SPRING),
						...(highlight.scrolled && {
							x: { duration: 0 },
							y: { duration: 0 },
						}),
						opacity: { duration: 0.08 },
					}}
				/>
			)}
		</AnimatePresence>
	);
}
