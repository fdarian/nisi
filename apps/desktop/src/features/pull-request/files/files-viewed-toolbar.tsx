import {
	Columns2Icon,
	RefreshCwIcon,
	RowsIcon,
	SlidersHorizontalIcon,
} from "lucide-react";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { Skeleton } from "#/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import {
	useDiffStyleMode,
	useHideReviewed,
	useIncludeUncommitted,
	useSidebarViewMode,
	useWrapLines,
} from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { filesToolbarClassName } from "./files-changed-layout";

type Counts = { total: number; viewed: number };
export function FilesViewedToolbar(props: {
	orpc: SidecarQueryUtils;
	counts?: Counts;
	hasPendingChanges?: boolean;
	onRefresh?: () => void;
}): React.ReactElement {
	const diffStyle = useDiffStyleMode(props.orpc);
	const viewMode = useSidebarViewMode(props.orpc);
	const hideReviewed = useHideReviewed(props.orpc);
	const includeUncommitted = useIncludeUncommitted(props.orpc);
	const wrapLines = useWrapLines(props.orpc);
	const loading = props.counts === undefined;
	return (
		<div className={filesToolbarClassName}>
			<span className="flex items-center gap-2">
				<ProgressCircle counts={props.counts} />
				<span>
					<span
						data-files-data
						className="font-medium text-foreground tabular-nums"
					>
						{props.counts === undefined ? (
							<Skeleton className="inline-block h-2 w-2" />
						) : (
							props.counts.viewed
						)}
					</span>{" "}
					of{" "}
					<span
						data-files-data
						className="font-medium text-foreground tabular-nums"
					>
						{props.counts === undefined ? (
							<Skeleton className="inline-block h-2 w-4" />
						) : (
							props.counts.total
						)}
					</span>{" "}
					viewed
				</span>
			</span>
			<div className="flex items-center gap-2">
				{props.hasPendingChanges && (
					<Button
						onClick={props.onRefresh}
						size="xs"
						variant="warning-secondary"
					>
						<RefreshCwIcon />
						Refresh
					</Button>
				)}
				<ToggleGroup
					disabled={loading}
					onValueChange={(value) => {
						const next = value[0];
						if (next === "unified" || next === "split") diffStyle[1](next);
					}}
					size="sm"
					value={[diffStyle[0]]}
					variant="outline"
				>
					<ToggleGroupItem aria-label="Unified diff" value="unified">
						<RowsIcon />
					</ToggleGroupItem>
					<ToggleGroupItem aria-label="Split diff" value="split">
						<Columns2Icon />
					</ToggleGroupItem>
				</ToggleGroup>
				<DropdownMenu>
					<DropdownMenuTrigger
						disabled={loading}
						aria-label="Files sidebar display options"
						className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
					>
						<SlidersHorizontalIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuRadioGroup
							value={viewMode[0]}
							onValueChange={(value) => {
								if (value === "tree" || value === "flat") viewMode[1](value);
							}}
						>
							<DropdownMenuRadioItem closeOnClick value="tree">
								Tree
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem closeOnClick value="flat">
								Flat
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							checked={hideReviewed[0]}
							onCheckedChange={hideReviewed[1]}
						>
							Hide reviewed
						</DropdownMenuCheckboxItem>
						<DropdownMenuCheckboxItem
							checked={wrapLines[0]}
							onCheckedChange={wrapLines[1]}
						>
							Wrap lines
						</DropdownMenuCheckboxItem>
						<DropdownMenuCheckboxItem
							checked={includeUncommitted[0]}
							onCheckedChange={includeUncommitted[1]}
						>
							Include uncommitted
						</DropdownMenuCheckboxItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	);
}

function ProgressCircle(props: { counts?: Counts }): React.ReactElement {
	const circumference = 2 * Math.PI * 45;
	const percent =
		props.counts === undefined || props.counts.total === 0
			? 0
			: Math.round((props.counts.viewed / props.counts.total) * 100);
	return (
		<svg
			aria-label={
				props.counts === undefined
					? "Loading review progress"
					: `${props.counts.viewed} of ${props.counts.total} viewed`
			}
			className="size-3.5 shrink-0"
			fill="none"
			role="img"
			viewBox="0 0 100 100"
		>
			<circle
				cx="50"
				cy="50"
				r="45"
				strokeWidth="10"
				className="stroke-border"
			/>
			<circle
				cx="50"
				cy="50"
				r="45"
				strokeWidth="10"
				className="stroke-foreground transition-[stroke-dasharray] duration-300 ease-linear motion-reduce:transition-none"
				strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
				strokeLinecap="round"
				style={{ transform: "rotate(-90deg)", transformOrigin: "50px 50px" }}
			/>
		</svg>
	);
}
