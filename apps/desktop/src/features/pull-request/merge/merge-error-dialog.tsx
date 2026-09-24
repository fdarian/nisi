"use client";

import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPopup,
	DialogTitle,
} from "#/components/ui/dialog";

export type MergeFailure = {
	title: string;
	reason: string;
	detail: string;
};

export function MergeErrorDialog(props: {
	failure: MergeFailure | null;
	onOpenChange: (open: boolean) => void;
}): React.ReactElement {
	return (
		<Dialog onOpenChange={props.onOpenChange} open={props.failure !== null}>
			<DialogPopup>
				<DialogHeader>
					<DialogTitle>{props.failure?.title}</DialogTitle>
					<DialogDescription>{props.failure?.reason}</DialogDescription>
				</DialogHeader>
				<div className="min-h-0 px-6 pb-6">
					<pre className="max-h-80 overflow-auto rounded-md border bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words select-text">
						{props.failure?.detail}
					</pre>
				</div>
				<DialogFooter>
					<Button
						disabled={props.failure === null}
						onClick={() => {
							if (props.failure !== null)
								void navigator.clipboard.writeText(props.failure.detail);
						}}
					>
						Copy
					</Button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
