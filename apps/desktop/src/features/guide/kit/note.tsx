import type { ReactNode } from "react";

/** A short written decision or caveat; put `Ref`s inside to point at the code it's about. */
export function Note(props: {
	label: string;
	children?: ReactNode;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-1.5 rounded-lg border bg-card px-3.5 py-3">
			<h3 className="m-0 font-heading font-semibold text-base text-foreground leading-snug">
				{props.label}
			</h3>
			<div className="flex flex-col gap-1.5 text-muted-foreground">
				{props.children}
			</div>
		</div>
	);
}
