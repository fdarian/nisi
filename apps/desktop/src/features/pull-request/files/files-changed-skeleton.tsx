import { Skeleton } from "#/components/ui/skeleton";
import { diffCodeViewLayout } from "#/features/diff/diff-view-theme";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { markFilesLoadingPainted } from "#/infra/launch-trace";
import { DiffFileHeader } from "./diff-pane/diff-file-header";
import {
	filesMainClassName,
	filesSidebarClassName,
} from "./files-changed-layout";
import { FilesViewedToolbar } from "./files-viewed-toolbar";
import { FilesFilter } from "./sidebar/files-filter";

const treeRows = [0, 1, 2, 2, 2, 1, 2, 2, 1, 2].map((depth, index) => ({
	id: `row-${index}`,
	depth,
	width: 64 + ((index * 23) % 80),
}));
const lineWidths = [48, 72, 58, 84, 36, 64, 76, 44];

type LoadingPaintProps = {
	/** Whether this skeleton is the one the user is looking at; a hidden tab must not record a launch paint. */
	when?: boolean;
	sessionId?: string;
};

export function loadingPaintRef(
	props: LoadingPaintProps,
): (node: HTMLElement | null) => void {
	return (node) => {
		if (node !== null && props.when !== false)
			markFilesLoadingPainted(node, props.sessionId);
	};
}

export function FilesChangedSkeleton(
	props: LoadingPaintProps & {
		orpc: SidecarQueryUtils;
		toolbarVisible?: boolean;
	},
): React.ReactElement {
	return (
		<div
			ref={loadingPaintRef(props)}
			className="flex min-h-0 flex-1 motion-reduce:[&_[data-slot=skeleton]]:animate-none"
			role="status"
			aria-label="Loading changed files"
		>
			<div className={filesSidebarClassName}>
				<FilesFilter disabled query="" mode="files" />
				<div data-files-data className="px-2" aria-hidden>
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
			<div className={filesMainClassName}>
				{props.toolbarVisible !== false ? (
					<FilesViewedToolbar orpc={props.orpc} />
				) : (
					<div className="h-12 shrink-0 sm:h-11" aria-hidden />
				)}
				<div className="min-h-0 flex-1 overflow-hidden bg-pane-surface px-3">
					<div
						className="flex flex-col"
						style={{ gap: diffCodeViewLayout.gap }}
					>
						{[0, 1, 2].map((card) => (
							<div
								key={card}
								className="overflow-hidden rounded-xl bg-background"
							>
								<DiffFileHeader />
								<div
									data-files-data
									className="border border-t-0 py-2"
									aria-hidden
								>
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
