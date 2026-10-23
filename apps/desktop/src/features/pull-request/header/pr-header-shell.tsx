type PrHeaderShellProps = {
	title: React.ReactNode;
	/** PR only: `#N` and the stack badge, muted, right after the title. Omitted for a branch session. */
	number?: React.ReactNode;
	stat: React.ReactNode;
	/** Leads the context row, ahead of `meta`. */
	repo: React.ReactNode;
	/** Segments of the context row after the repo: author and branches for a PR, what the diff is against for a branch session. */
	meta: React.ReactNode;
	/** Closes the context row, e.g. a notice icon. Must fit the row's `h-5`. */
	trailing?: React.ReactNode;
	/** PR-only controls (CI, merge) between the title block and the menu. */
	actions?: React.ReactNode;
	menu: React.ReactNode;
};

const CONTEXT_ROW_CLASS =
	"flex h-5 min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-muted-foreground text-xs";

/**
 * The header's rows and slots, shared by the real `PrHeader` and the loading
 * `PrHeaderSkeleton`, so the skeleton that stands in while a PR opens has the
 * exact geometry of what replaces it — nothing moves when the real one mounts.
 */
export function PrHeaderShell(props: PrHeaderShellProps): React.ReactElement {
	return (
		<div className="flex items-center gap-3 border-b py-4 pr-6 pl-4">
			<div className="flex min-w-0 flex-1 flex-col gap-1.5">
				<div className="flex min-w-0 items-baseline gap-2">
					<h1 className="truncate font-heading font-semibold text-base">
						{props.title}
					</h1>
					{props.number !== undefined && (
						<span className="inline-flex shrink-0 items-center gap-1.5 self-center text-base text-muted-foreground">
							{props.number}
						</span>
					)}
					{props.stat}
				</div>
				<div className={CONTEXT_ROW_CLASS}>
					<span className="shrink-0 font-medium text-foreground/70">
						{props.repo}
					</span>
					<span aria-hidden="true" className="shrink-0">
						·
					</span>
					{props.meta}
					{props.trailing}
				</div>
			</div>
			{props.actions !== undefined && (
				<div className="flex items-center gap-2">{props.actions}</div>
			)}
			{props.menu}
		</div>
	);
}
