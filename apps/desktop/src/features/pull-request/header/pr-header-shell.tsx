import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "#/components/ui/breadcrumb";

type PrHeaderShellProps = {
	/** First breadcrumb: the repository. */
	repo: React.ReactNode;
	/** Second breadcrumb: `#N`, or `vs <base>` for a branch session. */
	refLabel: React.ReactNode;
	/** Extra breadcrumb items after the second, e.g. a notice icon. Must fit the row's height. */
	breadcrumbTrailing?: React.ReactNode;
	title: React.ReactNode;
	stat: React.ReactNode;
	/** PR-only controls (CI, merge) between the title block and the menu. */
	actions?: React.ReactNode;
	menu: React.ReactNode;
};

/**
 * The header's rows and slots, shared by the real `PrHeader` and the loading
 * `PrHeaderSkeleton`, so the skeleton that stands in while a PR opens has the
 * exact geometry of what replaces it — nothing moves when the real one mounts.
 */
export function PrHeaderShell(props: PrHeaderShellProps): React.ReactElement {
	return (
		<div className="flex items-center gap-3 border-b pl-4 pr-6 py-2.5">
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<Breadcrumb>
					<BreadcrumbList className="text-xs h-6">
						<BreadcrumbItem>{props.repo}</BreadcrumbItem>
						<BreadcrumbSeparator />
						<BreadcrumbItem>
							<BreadcrumbPage className="text-muted-foreground">
								{props.refLabel}
							</BreadcrumbPage>
						</BreadcrumbItem>
						{props.breadcrumbTrailing}
					</BreadcrumbList>
				</Breadcrumb>
				<div className="flex min-w-0 items-baseline gap-2">
					<h1 className="truncate font-heading font-semibold text-base">
						{props.title}
					</h1>
					{props.stat}
				</div>
			</div>
			{props.actions !== undefined && (
				<div className="flex items-center gap-2">{props.actions}</div>
			)}
			{props.menu}
		</div>
	);
}
