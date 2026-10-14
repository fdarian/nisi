import type { ReactNode } from "react";

/** A string is an image src; anything else is rendered as-is. */
function Side(props: {
	label: string;
	value: ReactNode;
	tone: string;
}): React.ReactElement {
	return (
		<div className="flex min-w-0 flex-col gap-2 p-2.5">
			<span className={`font-mono text-[10.5px] ${props.tone}`}>
				{props.label}
			</span>
			{typeof props.value === "string" ? (
				<img
					alt={props.label}
					className="block w-full rounded-md border"
					src={props.value}
				/>
			) : (
				props.value
			)}
		</div>
	);
}

export function BeforeAfter(props: {
	before: ReactNode;
	after: ReactNode;
}): React.ReactElement {
	return (
		<div className="grid grid-cols-2 divide-x overflow-hidden rounded-lg border bg-card">
			<Side label="before" tone="text-muted-foreground" value={props.before} />
			<Side label="after" tone="text-green-500" value={props.after} />
		</div>
	);
}
