import {
	type MotionValue,
	motion,
	useMotionValue,
	useReducedMotion,
	useTransform,
} from "motion/react";
import { useLayoutEffect, useRef } from "react";
import { spring } from "#/lib/springs";
import {
	filesSidebarClassName,
	filesSidebarRailWidthPx,
	filesSidebarWidthPx,
} from "../files-changed-layout";

const HANDOFF_ANCHOR = "[data-handoff-anchor]";
// Wide enough to avoid a one-frame pop, narrow enough that both sets are never visibly on at once.
const HANDOFF_RAMP_PX = 2;

function anchorLeftWithin(container: HTMLElement): number {
	const anchor = container.querySelector(HANDOFF_ANCHOR);
	if (anchor === null) throw new Error("Sidebar handoff anchor is missing");
	return (
		anchor.getBoundingClientRect().left - container.getBoundingClientRect().left
	);
}

export function FilesSidebarShell(props: {
	collapsed: boolean;
	panel: (headerIconsOpacity: MotionValue<number>) => React.ReactNode;
	rail: React.ReactNode;
}): React.ReactElement {
	const reduceMotion = useReducedMotion();
	const open = !props.collapsed;
	const transition = reduceMotion
		? { duration: 0 }
		: open
			? spring.slow
			: spring.slow.exit;

	const panelRef = useRef<HTMLDivElement>(null);
	const railRef = useRef<HTMLDivElement>(null);
	const panelX = useMotionValue(open ? 0 : -filesSidebarWidthPx);
	// The panelX at which its Collapse button sits exactly over the rail's Expand button. Both
	// offsets are rect differences inside their own containers, so the panel's current transform cancels out.
	const handoffX = useMotionValue(Number.NEGATIVE_INFINITY);
	useLayoutEffect(() => {
		if (panelRef.current === null || railRef.current === null) return;
		handoffX.set(
			anchorLeftWithin(railRef.current) - anchorLeftWithin(panelRef.current),
		);
	}, [handoffX]);

	// Swapping on the buttons' positions, not a clock, means the two icon sets are never on screen together.
	const railOpacity = useTransform(() =>
		Math.min(
			1,
			Math.max(
				0,
				(handoffX.get() + HANDOFF_RAMP_PX / 2 - panelX.get()) / HANDOFF_RAMP_PX,
			),
		),
	);
	const headerIconsOpacity = useTransform(railOpacity, (value) => 1 - value);

	return (
		<motion.div
			className="relative h-full shrink-0 overflow-hidden bg-pane-surface-nested"
			initial={false}
			animate={{
				width: open ? filesSidebarWidthPx : filesSidebarRailWidthPx,
			}}
			transition={transition}
		>
			{/* The panel slides at its full width instead of shrinking with the shell, so labels never re-wrap mid-animation — the shrinking shell just clips it. */}
			<motion.div
				ref={panelRef}
				className={`absolute inset-y-0 left-0 ${filesSidebarClassName}`}
				style={{ width: filesSidebarWidthPx, x: panelX }}
				initial={false}
				animate={{ x: open ? 0 : -filesSidebarWidthPx }}
				transition={transition}
				inert={props.collapsed}
			>
				{props.panel(headerIconsOpacity)}
			</motion.div>
			<motion.div
				ref={railRef}
				className={`absolute inset-y-0 left-0 ${props.collapsed ? "" : "pointer-events-none"}`}
				style={{ width: filesSidebarRailWidthPx, opacity: railOpacity }}
				inert={open}
			>
				{props.rail}
			</motion.div>
		</motion.div>
	);
}
