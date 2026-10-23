import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";
import type {
	FileCategory,
	FileChange,
	FileStatus,
	ReviewStateEntry,
} from "#/features/pull-request/data/pr-data";
import type { SidebarViewMode } from "#/features/settings/settings-data";
import { FilesSidebar, type SearchMode } from "./files-sidebar";

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

type StoryProps = {
	initialQuery: string;
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

function Frame(props: StoryProps): React.ReactElement {
	const [collapsed, setCollapsed] = useState(props.initialCollapsed);
	const [query, setQuery] = useState(props.initialQuery);
	const [searchMode, setSearchMode] = useState<SearchMode>("files");
	const [hideReviewed, setHideReviewed] = useState(props.initialHideReviewed);
	const [viewMode, setViewMode] = useState(props.initialViewMode);
	const [reviewedPaths, setReviewedPaths] = useState<ReadonlySet<string>>(
		() => new Set(INITIALLY_REVIEWED),
	);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	const reviewState = useMemo(
		() => reviewedEntries(reviewedPaths),
		[reviewedPaths],
	);
	// Upstream of `FilesSidebar` in production (`FilesChangedView`), so the story does it too.
	const visibleFiles = useMemo(() => {
		const needle = query.toLowerCase();
		return FIXTURE_FILES.filter(
			(file) =>
				!(hideReviewed && reviewedPaths.has(file.path)) &&
				file.path.toLowerCase().includes(needle),
		);
	}, [query, hideReviewed, reviewedPaths]);

	return (
		<div className="flex h-screen bg-pane-surface">
			<FilesSidebar
				collapsed={collapsed}
				filterQuery={query}
				files={visibleFiles}
				hideReviewed={hideReviewed}
				onCollapsedChange={setCollapsed}
				onFilterQueryChange={setQuery}
				onHideReviewedChange={setHideReviewed}
				onMarkReviewed={(paths) =>
					setReviewedPaths((current) => new Set([...current, ...paths]))
				}
				onQuerySubmit={() => {}}
				onSearchModeChange={setSearchMode}
				onSelectPath={setSelectedPath}
				onViewModeChange={setViewMode}
				repoRoot={REPO_ROOT}
				reviewState={reviewState}
				searchMode={searchMode}
				selectedPath={selectedPath}
				shortcutsEnabled
				viewMode={viewMode}
			/>
			<div className="m-2 flex flex-1 items-center justify-center rounded-xl bg-muted/50 text-muted-foreground text-sm">
				Diff pane
			</div>
		</div>
	);
}

const meta = {
	title: "Pr/FilesSidebar",
	parameters: { layout: "fullscreen" },
	args: {
		initialQuery: "",
		initialHideReviewed: false,
		initialCollapsed: false,
		initialViewMode: "tree",
	},
	argTypes: {
		initialViewMode: { control: "radio", options: ["tree", "flat"] },
	},
	// Keyed so a control change re-seeds the story-local state.
	render: (args) => <Frame key={JSON.stringify(args)} {...args} />,
} satisfies Meta<StoryProps>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const FilterOpen: Story = { args: { initialQuery: "project" } };
export const HideReviewed: Story = { args: { initialHideReviewed: true } };
export const Collapsed: Story = { args: { initialCollapsed: true } };
export const FlatView: Story = { args: { initialViewMode: "flat" } };
