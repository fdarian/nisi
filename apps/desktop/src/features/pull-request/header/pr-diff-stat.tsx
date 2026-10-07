import { motion, useReducedMotion } from "motion/react";
import { Skeleton } from "#/components/ui/skeleton";
import type { DiffStat } from "./diff-stat";

/**
 * Skeleton bar and counts share one grid cell and crossfade, the same shape as
 * `ViewedLabel` in `files-viewed-toolbar.tsx`: a typical `+120 -40` is laid out
 * invisibly while loading so the row never changes height or shifts when the
 * numbers arrive.
 */
export function PrDiffStat(props: {
	stat: DiffStat;
}): React.ReactElement | null {
	const reducedMotion = useReducedMotion();
	const transition = {
		duration: reducedMotion ? 0 : 0.2,
		ease: "easeOut" as const,
	};
	const stat = props.stat;
	if (stat.status === "unavailable") return null;
	const loading = stat.status === "loading";
	return (
		<span className="inline-grid shrink-0 font-mono text-xs tabular-nums">
			<motion.span
				aria-hidden={loading}
				className="col-start-1 row-start-1 whitespace-nowrap"
				initial={false}
				animate={{ opacity: loading ? 0 : 1 }}
				transition={transition}
			>
				<span className="text-success-foreground">
					+{loading ? 120 : stat.additions}
				</span>{" "}
				<span className="text-destructive-foreground">
					-{loading ? 40 : stat.deletions}
				</span>
			</motion.span>
			<motion.span
				aria-hidden
				className="col-start-1 row-start-1 flex items-center"
				initial={false}
				animate={{ opacity: loading ? 1 : 0 }}
				transition={transition}
			>
				<Skeleton className="h-2 w-full" />
			</motion.span>
		</span>
	);
}
