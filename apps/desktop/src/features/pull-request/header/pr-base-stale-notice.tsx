"use client";

import { TriangleAlertIcon } from "lucide-react";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverDescription,
	PopoverPopup,
	PopoverTrigger,
} from "#/components/ui/popover";

type PrBaseStaleNoticeProps = {
	baseRef: string;
	isRetrying: boolean;
	onRetry: () => void;
};

/**
 * Sits in the header's breadcrumb row instead of a banner above the diff: a
 * failed background base fetch is worth knowing but never worth pushing the
 * file list down. Fixed `size-5` keeps the row at its `h-6`.
 */
export function PrBaseStaleNotice(
	props: PrBaseStaleNoticeProps,
): React.ReactElement {
	return (
		<Popover>
			<PopoverTrigger
				aria-label="Base may be stale"
				delay={150}
				openOnHover
				render={(triggerProps) => (
					<Button
						{...triggerProps}
						className="size-5 text-warning-foreground"
						size="icon-2xs"
						variant="ghost"
					>
						<TriangleAlertIcon />
					</Button>
				)}
			/>
			<PopoverPopup
				align="start"
				className="w-72"
				tooltipStyle
				viewportClassName="py-2 [--viewport-inline-padding:--spacing(3)]"
			>
				<PopoverDescription className="text-foreground text-xs">
					Couldn't fetch <span className="font-mono">{props.baseRef}</span>
					{"; showing the last fetched base."}
				</PopoverDescription>
				<Button
					className="mt-2"
					disabled={props.isRetrying}
					onClick={props.onRetry}
					size="xs"
					variant="outline"
				>
					Retry
				</Button>
			</PopoverPopup>
		</Popover>
	);
}
