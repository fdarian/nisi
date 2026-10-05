import { Skeleton } from "#/components/ui/skeleton";
import {
	diffCardHeaderClassName,
	diffCodeViewLayout,
} from "#/features/diff/diff-view-theme";
import {
	filesMainClassName,
	filesSidebarClassName,
	filesToolbarClassName,
} from "./files-changed-layout";

const treeRows = [0, 1, 2, 2, 2, 1, 2, 2, 1, 2].map((depth, index) => ({
	id: `row-${index}`,
	depth,
	width: 64 + ((index * 23) % 80),
}));
const lineWidths = [48, 72, 58, 84, 36, 64, 76, 44];

export function FilesChangedSkeleton(): React.ReactElement {
	return (
		<div
			className="flex min-h-0 flex-1 motion-reduce:[&_[data-slot=skeleton]]:animate-none"
			role="status"
			aria-label="Loading changed files"
		>
			<div className={filesSidebarClassName} aria-hidden>
				<div className="p-2">
					<Skeleton className="h-9 w-full rounded-lg sm:h-8" />
				</div>
				<div className="px-2">
					{treeRows.map((row) => (
						<div
							key={row.id}
							className="flex h-7 items-center gap-2"
							style={{ paddingLeft: 12 + row.depth * 16 }}
						>
							<Skeleton className="size-3.5 shrink-0" />
							<Skeleton className="h-2" style={{ width: row.width }} />
						</div>
					))}
				</div>
			</div>
			<div className={filesMainClassName} aria-hidden>
				<div className={filesToolbarClassName}>
					<div className="flex items-center gap-2">
						<Skeleton className="size-3.5 rounded-full" />
						<Skeleton className="h-2 w-24" />
					</div>
					<div className="flex items-center gap-2">
						<div className="flex">
							<Skeleton className="size-8 sm:size-7 rounded-r-none" />
							<Skeleton className="size-8 sm:size-7 rounded-l-none" />
						</div>
						<Skeleton className="size-8 sm:size-7" />
					</div>
				</div>
				<div className="min-h-0 flex-1 overflow-hidden px-3">
					<div
						className="flex flex-col"
						style={{ gap: diffCodeViewLayout.gap }}
					>
						{[0, 1, 2].map((card) => (
							<div
								key={card}
								className="overflow-hidden rounded-xl bg-background"
							>
								<div
									className={`flex items-center gap-3 px-3 ${diffCardHeaderClassName(false)}`}
								>
									<Skeleton className="size-3.5 shrink-0" />
									<Skeleton className="size-3.5 shrink-0" />
									<div className="min-w-0 flex-1">
										<Skeleton className="h-2 w-2/3 max-w-72" />
									</div>
									<Skeleton className="h-5 w-14" />
									<Skeleton className="h-2 w-12" />
									<div className="flex h-8 items-center gap-1.5 px-[calc(--spacing(2.5)-1px)] sm:h-7">
										<Skeleton className="size-4" />
										<Skeleton className="h-2 w-14" />
									</div>
									<Skeleton className="size-8 sm:size-7" />
								</div>
								<div className="border border-t-0 py-2">
									{lineWidths.map((width) => (
										<div
											key={width}
											className="flex h-5 items-center gap-4 px-3 opacity-40"
										>
											<Skeleton className="h-2 w-8 shrink-0" />
											<Skeleton
												className="h-2"
												style={{ width: `${width}%` }}
											/>
										</div>
									))}
								</div>
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}
