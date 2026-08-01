import type React from "react";
import {
	useIsDevToolScopeActive,
	useToastOnRefetch,
} from "#/components/devtool/dev-tool-context";
import { Popover, PopoverPopup, PopoverTrigger } from "#/components/ui/popover";
import { Switch } from "#/components/ui/switch";

/** The dev-only grab-handle button, now doubling as the trigger for the devtool popover — see `dev-tool-context.tsx`. */
export function DevToolButton(): React.ReactElement {
	return (
		<Popover>
			<PopoverTrigger className="h-3 px-2 group cursor-pointer">
				<div className="h-0.5 w-10 rounded-full bg-muted group-hover:bg-muted-foreground transition" />
			</PopoverTrigger>
			<PopoverPopup align="start" className="w-64" side="top">
				<DevToolOptions />
			</PopoverPopup>
		</Popover>
	);
}

/** Renders every option row whose scope is currently active, or a muted empty state when none apply. */
function DevToolOptions(): React.ReactElement {
	const isFilesChangedActive = useIsDevToolScopeActive("files-changed");

	if (!isFilesChangedActive) {
		return (
			<p className="text-muted-foreground text-sm">
				No devtool options for this view.
			</p>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			<ToastOnRefetchOption />
		</div>
	);
}

const TOAST_ON_REFETCH_ID = "devtool-toast-on-refetch";

function ToastOnRefetchOption(): React.ReactElement {
	const [toastOnRefetch, setToastOnRefetch] = useToastOnRefetch();

	return (
		<div className="flex items-center justify-between gap-3 text-sm">
			<label htmlFor={TOAST_ON_REFETCH_ID}>Toast on every refetch</label>
			<Switch
				checked={toastOnRefetch}
				id={TOAST_ON_REFETCH_ID}
				onCheckedChange={setToastOnRefetch}
			/>
		</div>
	);
}
