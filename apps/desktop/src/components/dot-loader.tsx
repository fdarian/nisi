import { cn } from "cn";
import type React from "react";

const ROWS = 3;
const COLS = 5;
const CELL = 4;
/** Fraction of `--fetching-cycle` between neighbouring diagonals. the last diagonal's band must clear by 30%, where the text shimmer starts (`@keyframes dot-loader`). */
const SWEEP_STEP = 0.029;

const DOTS = Array.from({ length: ROWS * COLS }, (_, index) => {
	const row = Math.floor(index / COLS);
	const col = index % COLS;
	return { row, col, key: index };
});

/**
 * A dot-matrix loader: a bright band sweeps diagonally across a grid of dim
 * dots, then idles for the rest of `--fetching-cycle` (the cycle is shared
 * with `FetchingIndicator`'s text shimmer, which runs in that idle time).
 * Pure CSS (`animate-dot-loader` in `index.css`) — each dot's
 * `animation-delay` is its diagonal position (row + col) as a fraction of the
 * cycle, offset negative by one cycle so the sweep is already underway on
 * mount. Colored by `currentColor`; size it with a width class, the viewBox
 * keeps the aspect.
 */
export function DotLoader({
	className,
	...props
}: React.ComponentProps<"svg">): React.ReactElement {
	return (
		<svg
			aria-label="Loading"
			className={cn("shrink-0", className)}
			fill="currentColor"
			role="status"
			viewBox={`0 0 ${COLS * CELL} ${ROWS * CELL}`}
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			{DOTS.map((dot) => (
				<circle
					key={dot.key}
					className="animate-dot-loader opacity-20 motion-reduce:animate-none motion-reduce:opacity-50"
					cx={dot.col * CELL + CELL / 2}
					cy={dot.row * CELL + CELL / 2}
					r={1.1}
					style={{
						animationDelay: `calc(var(--fetching-cycle) * ${(dot.row + dot.col) * SWEEP_STEP - 1})`,
					}}
				/>
			))}
		</svg>
	);
}
