import { cn } from "cn";
import type React from "react";
import { DotLoader } from "#/components/dot-loader";

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
			<span className="animate-fetching-shimmer bg-[linear-gradient(90deg,var(--muted-foreground)_40%,var(--shimmer-band)_50%,var(--muted-foreground)_60%)] bg-[length:300%_100%] bg-clip-text text-transparent [--shimmer-band:color-mix(in_oklab,var(--muted-foreground)_30%,var(--background))] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground dark:[--shimmer-band:var(--foreground)]">
				Fetching
			</span>
		</span>
	);
}
