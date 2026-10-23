import type { Meta, StoryObj } from "@storybook/react-vite";
import {
	EllipsisIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	SearchIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { FluidHoverHighlight, useFluidHover } from "#/components/fluid-hover";
import { Button } from "#/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "#/components/ui/empty";
import { Kbd } from "#/components/ui/kbd";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { ScrollArea } from "#/components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import type {
	FileCategory,
	FileChange,
	FileStatus,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import type { SidebarViewMode } from "#/features/settings/settings-data";
import { useNativeGlassShowing } from "#/features/settings/window-glass";
import { CATEGORY_LABELS, groupFilesByCategory } from "#/lib/tree-paths";
import { useKeyBindings } from "#/lib/use-key-bindings";
import { filesSidebarClassName } from "../files-changed-layout";
import { FileTreeView } from "./file-tree-view";
import { FilesFilter } from "./files-filter";
import type { SearchMode } from "./files-sidebar";
import { FlatFileGroup } from "./flat-file-group";

const FIXTURE_ROWS: readonly (readonly [
	string,
	FileStatus,
	FileCategory,
	number,
	number,
])[] = [
	["src/api/projects/index.ts", "modified", "implementation", 12, 4],
	["src/api/projects/queries.ts", "modified", "implementation", 31, 9],
	["src/api/projects/validation.ts", "added", "implementation", 48, 0],
	["src/api/projects/legacy-client.ts", "deleted", "implementation", 0, 63],
	[
		"src/components/projects/project-card.tsx",
		"modified",
		"implementation",
		7,
		2,
	],
	[
		"src/components/projects/project-list.tsx",
		"modified",
		"implementation",
		22,
		11,
	],
	[
		"src/components/projects/project-empty.tsx",
		"added",
		"implementation",
		29,
		0,
	],
	["src/features/review/review-store.ts", "modified", "implementation", 18, 6],
	[
		"src/features/review/use-review-shortcuts.ts",
		"added",
		"implementation",
		54,
		0,
	],
	["src/features/review/reconcile.ts", "modified", "implementation", 3, 3],
	["src/lib/cache/index.ts", "modified", "implementation", 5, 1],
	["src/lib/cache/ttl.ts", "added", "implementation", 21, 0],
	["src/lib/network/retry.ts", "modified", "implementation", 14, 8],
	["src/lib/network/offline-queue.ts", "deleted", "implementation", 0, 41],
	["src/api/projects/queries.test.ts", "modified", "test", 26, 5],
	["src/lib/cache/ttl.test.ts", "added", "test", 37, 0],
	["src/features/review/reconcile.test.ts", "modified", "test", 9, 2],
	["src/api/projects/generated/schema.ts", "modified", "generated", 120, 98],
];

const FIXTURE_FILES: readonly FileChange[] = FIXTURE_ROWS.map((row, index) => ({
	path: row[0],
	status: row[1],
	category: row[2],
	additions: row[3],
	deletions: row[4],
	fingerprint: `fixture-${index}`,
	binary: false,
	review: null,
}));

const INITIALLY_REVIEWED: readonly string[] = [
	"src/api/projects/index.ts",
	"src/api/projects/queries.ts",
	"src/components/projects/project-card.tsx",
	"src/lib/cache/index.ts",
	"src/lib/network/retry.ts",
];

const REPO_ROOT = "/Users/dev/code/nisi";

type FilterPlacement = "replace" | "below";

type SidebarProps = {
	filterPlacement: FilterPlacement;
	initialFilterOpen: boolean;
	initialHideReviewed: boolean;
	initialCollapsed: boolean;
	initialViewMode: SidebarViewMode;
};

function reviewedEntries(
	paths: ReadonlySet<string>,
): ReadonlyMap<string, ReviewStateEntry> {
	return new Map(
		Array.from(paths, (path) => [path, { status: "viewed" }] as const),
	);
}

/** A reduced copy of `files-sidebar.tsx`'s unexported `FlatFileList`. */
function FlatFileList(props: {
	groups: ReturnType<typeof groupFilesByCategory>;
	reviewState: ReadonlyMap<string, ReviewStateEntry>;
	selectedPath: string | null;
	onSelectPath: (path: string) => void;
}): React.ReactElement {
	const glassShowing = useNativeGlassShowing();
	const hover = useFluidHover<HTMLDivElement>("y");

	return (
		<div
			className="relative flex flex-col gap-1 pb-3"
			ref={hover.containerRef}
			{...(glassShowing ? hover.handlers : {})}
		>
			{glassShowing && (
				<FluidHoverHighlight
					className="rounded-md bg-sidebar-accent"
					hover={hover}
				/>
			)}
			{props.groups.map((group) => (
				<FlatFileGroup
					key={group.category}
					files={group.files}
					onSelectPath={props.onSelectPath}
					registerHoverItem={hover.registerItem}
					glassShowing={glassShowing}
					reviewState={props.reviewState}
					selectedPath={props.selectedPath}
					title={CATEGORY_LABELS[group.category]}
				/>
			))}
		</div>
	);
}

function HeaderTooltip(props: {
	label: string;
	shortcut?: string;
	children: React.ReactElement;
}): React.ReactElement {
	return (
		<Tooltip>
			<TooltipTrigger render={props.children} />
			<TooltipPopup>
				{props.label}
				{props.shortcut !== undefined && (
					<Kbd className="ml-1.5">{props.shortcut}</Kbd>
				)}
			</TooltipPopup>
		</Tooltip>
	);
}

function HeaderIconButton(props: {
	label: string;
	shortcut?: string;
	icon: React.ReactElement;
	onClick: () => void;
}): React.ReactElement {
	return (
		<HeaderTooltip label={props.label} shortcut={props.shortcut}>
			<Button
				aria-label={props.label}
				onClick={props.onClick}
				size="icon-xs"
				variant="ghost"
			>
				{props.icon}
			</Button>
		</HeaderTooltip>
	);
}

function ExperimentalFilesSidebar(props: SidebarProps): React.ReactElement {
	const [collapsed, setCollapsed] = useState(props.initialCollapsed);
	const [filterOpen, setFilterOpen] = useState(props.initialFilterOpen);
	const [query, setQuery] = useState("");
	const [searchMode, setSearchMode] = useState<SearchMode>("files");
	const [hideReviewed, setHideReviewed] = useState(props.initialHideReviewed);
	const [viewMode, setViewMode] = useState(props.initialViewMode);
	const [reviewedPaths, setReviewedPaths] = useState<ReadonlySet<string>>(
		() => new Set(INITIALLY_REVIEWED),
	);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const filterInputRef = useRef<HTMLInputElement>(null);

	const reviewState = useMemo(
		() => reviewedEntries(reviewedPaths),
		[reviewedPaths],
	);
	const visibleFiles = useMemo(() => {
		const needle = query.toLowerCase();
		return FIXTURE_FILES.filter(
			(file) =>
				!(hideReviewed && reviewedPaths.has(file.path)) &&
				file.path.toLowerCase().includes(needle),
		);
	}, [query, hideReviewed, reviewedPaths]);
	const groups = useMemo(
		() => groupFilesByCategory(visibleFiles),
		[visibleFiles],
	);

	const filterVisible = filterOpen && !collapsed;
	useEffect(() => {
		if (filterVisible) filterInputRef.current?.focus();
	}, [filterVisible]);

	const closeFilter = () => {
		setFilterOpen(false);
		setQuery("");
	};
	const openFilter = () => {
		setCollapsed(false);
		setFilterOpen(true);
	};

	useKeyBindings({
		"mod+f": () => {
			if (filterVisible) {
				filterInputRef.current?.focus();
				filterInputRef.current?.select();
				return;
			}
			openFilter();
		},
	});

	if (collapsed) {
		return (
			<div className="flex h-full w-10 shrink-0 flex-col items-center gap-1 bg-pane-surface-nested py-2">
				<HeaderIconButton
					icon={<PanelLeftOpenIcon />}
					label="Expand sidebar"
					onClick={() => setCollapsed(false)}
				/>
				<HeaderIconButton
					icon={<SearchIcon />}
					label="Filter files"
					onClick={openFilter}
					shortcut="⌘F"
				/>
			</div>
		);
	}

	const filter = (
		<FilesFilter
			inputRef={filterInputRef}
			mode={searchMode}
			onModeChange={setSearchMode}
			onQueryChange={setQuery}
			query={query}
		/>
	);
	// Events from the mode dropdown's portal bubble through React too, so only
	// the input's own Escape/blur may close the filter.
	const filterHandlers = {
		onKeyDown: (event: React.KeyboardEvent) => {
			if (event.key === "Escape" && event.target === filterInputRef.current)
				closeFilter();
		},
		onBlur: (event: React.FocusEvent) => {
			const stayedInside =
				event.relatedTarget instanceof Node &&
				event.currentTarget.contains(event.relatedTarget);
			if (
				event.target === filterInputRef.current &&
				!stayedInside &&
				query.length === 0
			)
				closeFilter();
		},
	};

	const header = (
		<div className="flex h-9 shrink-0 items-center justify-between pr-2 pl-3">
			<span className="text-muted-foreground text-xs">
				{visibleFiles.length} files
			</span>
			<div className="flex items-center gap-0.5">
				<HeaderIconButton
					icon={<SearchIcon />}
					label="Filter files"
					onClick={openFilter}
					shortcut="⌘F"
				/>
				<DropdownMenu>
					<HeaderTooltip label="More">
						<DropdownMenuTrigger
							render={
								<Button aria-label="More" size="icon-xs" variant="ghost">
									<EllipsisIcon />
								</Button>
							}
						/>
					</HeaderTooltip>
					<DropdownMenuContent align="end">
						<DropdownMenuCheckboxItem
							checked={hideReviewed}
							onCheckedChange={setHideReviewed}
						>
							Hide reviewed
						</DropdownMenuCheckboxItem>
						<DropdownMenuSeparator />
						<DropdownMenuRadioGroup
							onValueChange={(value) => {
								if (value === "tree" || value === "flat") setViewMode(value);
							}}
							value={viewMode}
						>
							<DropdownMenuRadioItem value="tree">Tree</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="flat">Flat</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem>Collapse all folders</DropdownMenuItem>
						<DropdownMenuItem>Expand all folders</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<HeaderIconButton
					icon={<PanelLeftCloseIcon />}
					label="Collapse sidebar"
					onClick={() => setCollapsed(true)}
				/>
			</div>
		</div>
	);

	return (
		<div className={filesSidebarClassName}>
			{filterVisible && props.filterPlacement === "replace" ? (
				<div className="flex shrink-0 items-center pr-2" {...filterHandlers}>
					<div className="min-w-0 flex-1">{filter}</div>
					<Button
						aria-label="Close filter"
						onClick={closeFilter}
						size="icon-xs"
						variant="ghost"
					>
						<XIcon />
					</Button>
				</div>
			) : (
				<>
					{header}
					{filterVisible && (
						<div className="shrink-0" {...filterHandlers}>
							{filter}
						</div>
					)}
				</>
			)}
			<div data-files-data className="flex min-h-0 flex-1 flex-col">
				{groups.length === 0 ? (
					<Empty className="px-4 py-8">
						<EmptyTitle className="text-sm">No matching files</EmptyTitle>
						<EmptyDescription>Try a different filter query.</EmptyDescription>
					</Empty>
				) : viewMode === "tree" ? (
					<FileTreeView
						files={visibleFiles}
						onMarkReviewed={(paths) =>
							setReviewedPaths((current) => new Set([...current, ...paths]))
						}
						onSelectPath={setSelectedPath}
						repoRoot={REPO_ROOT}
						reviewState={reviewState}
						selectedPath={selectedPath}
					/>
				) : (
					<ScrollArea className="min-h-0 flex-1" scrollFade>
						<FlatFileList
							groups={groups}
							onSelectPath={setSelectedPath}
							reviewState={reviewState}
							selectedPath={selectedPath}
						/>
					</ScrollArea>
				)}
			</div>
		</div>
	);
}

function Frame(props: SidebarProps): React.ReactElement {
	return (
		<div className="flex h-screen bg-pane-surface">
			<ExperimentalFilesSidebar {...props} />
			<div className="m-2 flex flex-1 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground text-sm">
				Diff pane
			</div>
		</div>
	);
}

const meta = {
	title: "Pr/FilesSidebar/Header experiment",
	parameters: { layout: "fullscreen" },
	args: {
		filterPlacement: "replace",
		initialFilterOpen: false,
		initialHideReviewed: false,
		initialCollapsed: false,
		initialViewMode: "tree",
	},
	argTypes: {
		filterPlacement: { control: "radio", options: ["replace", "below"] },
		initialViewMode: { control: "radio", options: ["tree", "flat"] },
	},
	// Keyed so a control change re-seeds the sidebar's initial state.
	render: (args) => <Frame key={JSON.stringify(args)} {...args} />,
} satisfies Meta<SidebarProps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const FilterOpenReplace: Story = {
	args: { filterPlacement: "replace", initialFilterOpen: true },
};
export const FilterOpenBelow: Story = {
	args: { filterPlacement: "below", initialFilterOpen: true },
};
export const HideReviewed: Story = { args: { initialHideReviewed: true } };
export const Collapsed: Story = { args: { initialCollapsed: true } };
export const FlatView: Story = { args: { initialViewMode: "flat" } };
