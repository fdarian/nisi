import type { GitPullRequestArrowIcon } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * lucide-react's own exported `LucideProps` type structurally loses
 * `className` (and the rest of `SVGProps`) through its `interface extends`
 * of an intersection involving a `Partial<...>` mapped type — reproducible
 * in isolation against this exact package version, unrelated to this file.
 * Deriving the prop type from a real icon component instead sidesteps it
 * while staying exactly as compatible as every other lucide icon usage in
 * this codebase.
 */
type LucideIconProps = ComponentProps<typeof GitPullRequestArrowIcon>;

/**
 * Lucide has no merged-PR icon, so this is hand-authored to sit in the same
 * visual family as lucide's `git-pull-request-arrow` — `PrTabIcon`
 * (`pr-tab-strip.tsx`) swaps between the two in place as a PR's status
 * changes, so a node position that moved would make the badge visibly jump.
 *
 * Both nodes and the vertical branch (`M5 9v12`) are `git-pull-request-arrow`'s
 * own, unchanged. Only its arrowhead + right-angle connector are replaced,
 * with a merge arc in the spirit of `git-merge`'s `M6 21V9a9 9 0 0 0 9 9` —
 * a branch landing *into* the bottom node instead of pointing away from it.
 * Naively shifting `git-merge`'s arc onto this grid (`git-pull-request-arrow`
 * moved the nodes to cx 5/19, off `git-merge`'s own 6/18) leaves it short of
 * the bottom node's edge; re-fit as a quarter-ellipse (rx 11, ry 9) instead
 * of a quarter-circle so it starts at `M5 9v12`'s own start point with a
 * matching vertical tangent and lands exactly on the bottom node's left
 * edge (`cx − r` = 19 − 3 = 16) with a horizontal one, the same tangent
 * convention `git-merge` itself uses to enter its own node.
 */
export function GitPullRequestMergedIcon({
	size = 24,
	...props
}: LucideIconProps): React.ReactElement {
	return (
		<svg
			aria-hidden="true"
			fill="none"
			height={size}
			stroke="currentColor"
			strokeLinecap="round"
			strokeLinejoin="round"
			strokeWidth={2}
			viewBox="0 0 24 24"
			width={size}
			xmlns="http://www.w3.org/2000/svg"
			{...props}
		>
			<circle cx="5" cy="6" r="3" />
			<path d="M5 9v12" />
			<circle cx="19" cy="18" r="3" />
			<path d="M5 9a11 9 0 0 0 11 9" />
		</svg>
	);
}
