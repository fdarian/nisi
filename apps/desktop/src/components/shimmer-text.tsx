import { cn } from "cn";
import type React from "react";

/** Text with a lighter band sweeping across it; reduced motion leaves it static. Sized and positioned by the caller, colored by `--muted-foreground`. */
export function ShimmerText({
	className,
	...props
}: React.ComponentProps<"span">): React.ReactElement {
	return (
		<span
			className={cn(
				"animate-fetching-shimmer bg-[linear-gradient(90deg,var(--muted-foreground)_40%,var(--shimmer-band)_50%,var(--muted-foreground)_60%)] bg-[length:300%_100%] bg-clip-text text-transparent [--shimmer-band:color-mix(in_oklab,var(--muted-foreground)_30%,var(--background))] motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground dark:[--shimmer-band:var(--foreground)]",
				className,
			)}
			{...props}
		/>
	);
}
