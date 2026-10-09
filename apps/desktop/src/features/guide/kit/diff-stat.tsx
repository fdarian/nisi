/** Only the sides that changed: a file with no deletions reads `+12`, not `+12 −0`. */
export function DiffStat(props: {
	additions: number;
	deletions: number;
}): React.ReactElement {
	return (
		<>
			{props.additions > 0 && (
				<span className="text-success-foreground">+{props.additions}</span>
			)}
			{props.additions > 0 && props.deletions > 0 && " "}
			{props.deletions > 0 && (
				<span className="text-destructive-foreground">−{props.deletions}</span>
			)}
		</>
	);
}
