"use client";

import { cn } from "cn";
import { Server } from "lucide-react";
import { Button } from "#/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import { useSessionCodeIndexEnabled } from "#/features/pull-request/data/session-ui-store";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useCodeIndexLspControl } from "./code-index-lsp";

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
		<div className="flex items-center gap-0.5">
			<span
				aria-hidden="true"
				className={cn(
					"size-1 shrink-0 rounded-full",
					STATUS_DOT_CLASS[control.status],
				)}
			/>
			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							aria-label={tooltip}
							onClick={control.toggle}
							size="icon-xs"
							variant="ghost"
							className="data-[status=off]:text-muted-foreground"
							data-status={control.status}
						>
							<Server />
						</Button>
					}
				/>
				<TooltipPopup>{tooltip}</TooltipPopup>
			</Tooltip>
		</div>
	);
}
