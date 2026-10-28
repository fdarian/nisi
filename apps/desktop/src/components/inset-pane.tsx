import { cn } from "cn";
import type * as React from "react";
import { FramePanel } from "#/components/ui/frame";

/**
 * The inner panel both the PR tabs (`AppShell`) and the settings page sit in.
 *
 * Layered onto `FramePanel` (`ui/frame.tsx`, the vendored coss ui recipe) so
 * the pane picks up its hairline `border` and `shadow-xs/5` edge — `p-0`
 * overrides `FramePanel`'s own `p-5` via `cn`'s `twMerge`, since the pane
 * manages its own children's padding.
 *
 * The surface is declared as `--pane-surface` in `index.css` and consumed by
 * `bg-pane-surface` here so descendants can reach the exact tone they sit on
 * — the diff pane's cards need it to paint the corners of a pinned file
 * header, and they can't derive it, since `background` doesn't inherit
 * (`diffCardChromeCSS`). Don't swap in `bg-background`: it ignores the
 * Panel translucency setting.
 */
export function InsetPane({
	className,
	...props
}: React.ComponentProps<typeof FramePanel>): React.ReactElement {
	return (
		<FramePanel
			className={cn(
				"m-2 flex min-h-0 flex-1 flex-col overflow-hidden bg-pane-surface p-0",
				className,
			)}
			{...props}
		/>
	);
}
