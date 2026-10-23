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
} from "react";

/**
 * Fluid hover (https://www.fluidfunctionalism.com/docs/fluid-hover): one
 * highlight follows the pointer to the item nearest it and glides between
 * items. A trimmed port of the registry's `useFluidHover` — no gap-click
 * routing, and rects are read at pointer time instead of cached, since a tab
 * strip reorders and resizes under it.
 */

type Rect = { left: number; top: number; width: number; height: number };

type Active = { element: HTMLElement; rect: Rect };

type FluidHover<T extends HTMLElement> = {
	containerRef: RefObject<T | null>;
	handlers: {
		onMouseEnter: () => void;
		onMouseLeave: () => void;
		onMouseMove: (event: MouseEvent) => void;
	};
	/** Ref callback for each hoverable item; items may mount in any order. */
	registerItem: RefCallback<HTMLElement>;
	rect: Rect | null;
	/** Steps on each pointer entry so the highlight fades in at the new item instead of sliding from the last one. */
	session: number;
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
	pointer: { x: number; y: number },
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

/** `containerRef` must sit on a `relative` element that contains every registered item. */
export function useFluidHover<T extends HTMLElement>(
	axis: "x" | "y",
): FluidHover<T> {
	const containerRef = useRef<T | null>(null);
	const itemsRef = useRef(new Set<HTMLElement>());
	const frameRef = useRef<number | null>(null);
	const pointerRef = useRef<{ x: number; y: number } | null>(null);
	const sessionPendingRef = useRef(false);
	const activeElementRef = useRef<HTMLElement | null>(null);
	const [active, setActive] = useState<Active | null>(null);
	const [session, setSession] = useState(0);

	const cancelFrame = useCallback(() => {
		if (frameRef.current === null) return;
		cancelAnimationFrame(frameRef.current);
		frameRef.current = null;
	}, []);

	const pick = useCallback(() => {
		frameRef.current = null;
		const container = containerRef.current;
		const pointer = pointerRef.current;
		if (container === null || pointer === null) return;
		const element = pickNearest(itemsRef.current, axis, pointer);
		if (element === null) return;
		if (sessionPendingRef.current && element !== activeElementRef.current) {
			sessionPendingRef.current = false;
			setSession((current) => current + 1);
		}
		activeElementRef.current = element;
		const rect = measure(element, container);
		setActive((current) =>
			current !== null &&
			current.element === element &&
			sameRect(current.rect, rect)
				? current
				: { element, rect },
		);
	}, [axis]);

	/** Re-picks from the last pointer position, which a layout shift or scroll can leave under a different item without a `mousemove`. */
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
					setActive(null);
					schedulePick();
				}
			};
		},
		[schedulePick],
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
		setActive(null);
	}, [cancelFrame]);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;
		const observer = new ResizeObserver(schedulePick);
		observer.observe(container);
		// Capture: scroll events don't bubble, and the scroller is an ancestor of the container.
		window.addEventListener("scroll", schedulePick, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("scroll", schedulePick, true);
		};
	}, [schedulePick]);

	const activeElement = active === null ? null : active.element;
	useEffect(() => {
		if (activeElement === null) return;
		activeElement.setAttribute(ACTIVE_ATTR, "");
		return () => activeElement.removeAttribute(ACTIVE_ATTR);
	}, [activeElement]);

	useEffect(() => cancelFrame, [cancelFrame]);

	return {
		containerRef,
		handlers: { onMouseEnter, onMouseLeave, onMouseMove },
		registerItem,
		rect: active === null ? null : active.rect,
		session,
	};
}

const MOVE_SPRING = { type: "spring", duration: 0.08, bounce: 0 } as const;

export function FluidHoverHighlight(props: {
	className?: string;
	hidden?: boolean;
	hover: Pick<FluidHover<HTMLElement>, "rect" | "session">;
}): React.ReactElement {
	const reducedMotion = useReducedMotion();
	const rect = props.hidden ? null : props.hover.rect;
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
					key={props.hover.session}
					transition={{
						...(reducedMotion ? { duration: 0 } : MOVE_SPRING),
						opacity: { duration: 0.08 },
					}}
				/>
			)}
		</AnimatePresence>
	);
}
