import {
	Columns2Icon,
	RefreshCwIcon,
	RowsIcon,
	SlidersHorizontalIcon,
	XIcon,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
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
	/** Adds a close button at the right end — set where the bar sits over a dismissible pane (the Guide's) rather than the Files Changed tab. */
	onClose?: () => void;
	/** The Tree/Flat radio configures the files sidebar, which a pane without one has no use for. Defaults on. */
	showSidebarOptions?: boolean;
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
				<ViewedLabel counts={props.counts} />
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
						{props.showSidebarOptions !== false && (
							<>
								<DropdownMenuRadioGroup
									value={viewMode[0]}
									onValueChange={(value) => {
										if (value === "tree" || value === "flat")
											viewMode[1](value);
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
							</>
						)}
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
				{props.onClose !== undefined && (
					<Button
						aria-label="Close diff pane"
						onClick={props.onClose}
						size="icon-sm"
						variant="ghost"
					>
						<XIcon />
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * Skeleton bar and text share one grid cell and crossfade. The text is always
 * laid out (invisibly, with a typical "0 of 20 viewed" while loading) so the
 * cell never resizes at the moment the skeleton hands over.
 */
function ViewedLabel(props: { counts?: Counts }): React.ReactElement {
	const reducedMotion = useReducedMotion();
	const transition = {
		duration: reducedMotion ? 0 : 0.2,
		ease: "easeOut" as const,
	};
	const loading = props.counts === undefined;
	return (
		<span className="inline-grid">
			<motion.span
				aria-hidden={loading}
				className="col-start-1 row-start-1 whitespace-nowrap"
				initial={false}
				animate={{ opacity: loading ? 0 : 1 }}
				transition={transition}
			>
				<span className="font-medium text-foreground tabular-nums">
					{props.counts === undefined ? 0 : props.counts.viewed}
				</span>{" "}
				of{" "}
				<span className="font-medium text-foreground tabular-nums">
					{props.counts === undefined ? 20 : props.counts.total}
				</span>{" "}
				viewed
			</motion.span>
			<motion.span
				aria-hidden
				className="col-start-1 row-start-1 flex items-center"
				initial={false}
				animate={{ opacity: loading ? 1 : 0 }}
				transition={transition}
			>
				<Skeleton className="h-2 w-full" />
			</motion.span>
		</span>
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
