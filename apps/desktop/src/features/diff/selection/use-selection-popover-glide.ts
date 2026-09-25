import { animate, useMotionValue, useReducedMotion } from "motion/react";
import { useCallback, useLayoutEffect, useState } from "react";

const SPRING = { type: "spring", duration: 0.08, bounce: 0 } as const;

export function useSelectionPopoverGlide(open: boolean) {
	const [positioner, setPositioner] = useState<HTMLDivElement | null>(null);
	const positionerRef = useCallback((element: HTMLDivElement | null) => {
		setPositioner(element);
	}, []);
	const x = useMotionValue(0);
	const y = useMotionValue(0);
	const reducedMotion = useReducedMotion();

	useLayoutEffect(() => {
		if (!open) {
			x.set(0);
			y.set(0);
			return;
		}
		if (positioner === null) return;
		const previousRect = { current: null as DOMRect | null };
		const animations = {
			x: undefined as ReturnType<typeof animate> | undefined,
			y: undefined as ReturnType<typeof animate> | undefined,
		};
		const measure = () => {
			// Base UI puts the unpositioned popup at 0,0 with inline opacity 0.
			if (positioner.style.opacity !== "") return;
			const rect = positioner.getBoundingClientRect();
			const previous = previousRect.current;
			previousRect.current = rect;
			if (previous === null) return;
			const dx = rect.x - previous.x;
			const dy = rect.y - previous.y;
			if (reducedMotion) {
				animations.x?.stop();
				animations.y?.stop();
				x.set(0);
				y.set(0);
				return;
			}
			if (dx !== 0) {
				animations.x?.stop();
				x.set(x.get() - dx);
				animations.x = animate(x, 0, SPRING);
			}
			if (dy !== 0) {
				animations.y?.stop();
				y.set(y.get() - dy);
				animations.y = animate(y, 0, SPRING);
			}
		};
		const observer = new MutationObserver(measure);
		observer.observe(positioner, {
			attributes: true,
			attributeFilter: ["style"],
		});
		measure();
		return () => {
			observer.disconnect();
			animations.x?.stop();
			animations.y?.stop();
			x.set(0);
			y.set(0);
		};
	}, [open, positioner, reducedMotion, x, y]);

	return { positionerRef, x, y };
}
