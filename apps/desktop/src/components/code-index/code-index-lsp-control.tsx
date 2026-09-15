"use client";

import { Server } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useCodeIndexLspControl } from "#/lib/code-index-lsp";
import { useSessionCodeIndexEnabled } from "#/lib/session-ui-store";
import { cn } from "#/lib/utils";

const STATUS_DOT_CLASS = {
	off: "bg-muted-foreground/50",
	starting: "animate-pulse bg-warning",
	on: "bg-success",
} as const;

export function CodeIndexLspControl(props: {
	orpc: SidecarQueryUtils;
	sessionId: string;
}): React.ReactElement {
	const sessionEnabled = useSessionCodeIndexEnabled(props.sessionId);
	const setEnabled = sessionEnabled[1];
	const control = useCodeIndexLspControl(
		props.orpc,
		props.sessionId,
		setEnabled,
	);
	const tooltip = control.status === "off" ? "Start LSP" : "Stop LSP";

	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={tooltip}
						onClick={control.toggle}
						size="icon-sm"
						variant="ghost"
					>
						<span
							aria-hidden="true"
							className={cn(
								"size-2 shrink-0 rounded-full",
								STATUS_DOT_CLASS[control.status],
							)}
						/>
						<Server />
					</Button>
				}
			/>
			<TooltipPopup>{tooltip}</TooltipPopup>
		</Tooltip>
	);
}
