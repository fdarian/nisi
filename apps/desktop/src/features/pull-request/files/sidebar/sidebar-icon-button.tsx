import { Button } from "#/components/ui/button";
import { Kbd } from "#/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";

export function SidebarTooltip(props: {
	label: string;
	shortcut?: string;
	children: React.ReactElement;
}): React.ReactElement {
	return (
		<Tooltip>
			<TooltipTrigger render={props.children} />
			<TooltipPopup>
				{props.label}
				{props.shortcut !== undefined && (
					<Kbd className="ml-1.5">{props.shortcut}</Kbd>
				)}
			</TooltipPopup>
		</Tooltip>
	);
}

export function SidebarIconButton(props: {
	label: string;
	shortcut?: string;
	icon: React.ReactElement;
	onClick: () => void;
	/** Set on a button that moves focus into an input, so the press doesn't first blur that input. */
	keepFocus?: boolean;
}): React.ReactElement {
	return (
		<SidebarTooltip label={props.label} shortcut={props.shortcut}>
			<Button
				aria-label={props.label}
				onClick={props.onClick}
				onMouseDown={
					props.keepFocus === true
						? (event) => event.preventDefault()
						: undefined
				}
				size="icon-xs"
				variant="ghost"
			>
				{props.icon}
			</Button>
		</SidebarTooltip>
	);
}
