import { cn } from "cn";
import type React from "react";
import { DotLoader } from "#/components/dot-loader";
import { ShimmerText } from "#/components/shimmer-text";

/** The dots plus a shimmering "Fetching" label — a lighter band sweeps across the text; reduced motion leaves it static. */
export function FetchingIndicator({
	className,
	...props
}: React.ComponentProps<"span">): React.ReactElement {
	return (
		<span
			className={cn(
				"me-4 flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs",
				className,
			)}
			{...props}
		>
			<DotLoader className="w-4" />
			<ShimmerText>Fetching</ShimmerText>
		</span>
	);
}
