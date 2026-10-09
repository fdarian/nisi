import type { ReactNode } from "react";

/** The lead of a guide: what changed, in a sentence the reader can stop at. */
export function Outcome(props: {
	title?: string;
	children?: ReactNode;
}): React.ReactElement {
	return (
		<header className="flex flex-col gap-1.5">
			<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
				Outcome
			</span>
			{props.title !== undefined && (
				<h1 className="font-heading font-semibold text-xl leading-snug tracking-tight">
					{props.title}
				</h1>
			)}
			{props.children !== undefined && (
				<div className="max-w-prose text-muted-foreground leading-relaxed">
					{props.children}
				</div>
			)}
		</header>
	);
}
