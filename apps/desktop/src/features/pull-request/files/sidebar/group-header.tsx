/** Shared section header for one category group — used both as `@pierre/trees`'s `header` slot (tree mode) and above the plain list (flat mode), so the two modes read identically. */
export function GroupHeader({
	title,
	count,
}: {
	title: string;
	count: number;
}): React.ReactElement {
	return (
		<div className="flex items-center justify-between px-2 pt-3 pb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
			<span>{title}</span>
			<span className="font-mono text-[0.6875rem] tabular-nums">{count}</span>
		</div>
	);
}
