import { motion, useReducedMotion } from "motion/react";
import { spring } from "#/lib/springs";
import {
	filesSidebarClassName,
	filesSidebarRailWidthPx,
	filesSidebarWidthPx,
} from "../files-changed-layout";

export function FilesSidebarShell(props: {
	collapsed: boolean;
	panel: React.ReactNode;
	rail: React.ReactNode;
}): React.ReactElement {
	const reduceMotion = useReducedMotion();
	const open = !props.collapsed;
	const transition = reduceMotion
		? { duration: 0 }
		: open
			? spring.slow
			: spring.slow.exit;
	// Critically damped: opacity must not overshoot 1.
	const fadeTransition = reduceMotion
		? { duration: 0 }
		: props.collapsed
			? spring.moderate
			: spring.moderate.exit;

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
				className={`absolute inset-y-0 left-0 ${filesSidebarClassName}`}
				style={{ width: filesSidebarWidthPx }}
				initial={false}
				animate={{ x: open ? "0%" : "-100%" }}
				transition={transition}
				inert={props.collapsed}
			>
				{props.panel}
			</motion.div>
			<motion.div
				className={`absolute inset-y-0 left-0 ${props.collapsed ? "" : "pointer-events-none"}`}
				style={{ width: filesSidebarRailWidthPx }}
				initial={false}
				animate={{ opacity: props.collapsed ? 1 : 0 }}
				transition={fadeTransition}
				inert={open}
			>
				{props.rail}
			</motion.div>
		</motion.div>
	);
}
