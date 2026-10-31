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

function toFileChanges(
	rows: typeof FIXTURE_ROWS,
	binaryPaths: ReadonlySet<string> = new Set(),
): readonly FileChange[] {
	return rows.map((row, index) => ({
		path: row[0],
		status: row[1],
		category: row[2],
		additions: row[3],
		deletions: row[4],
		fingerprint: `fixture-${index}`,
		binary: binaryPaths.has(row[0]),
		review: null,
	}));
}

const FIXTURE_FILES = toFileChanges(FIXTURE_ROWS);

const RENAME_LONG_PATH =
	"src/routes/_telegram/workflows/components/telegram-unavailable-channel-notice-banner.tsx";
const RENAME_BINARY_PATH = "src/assets/logo-mark.png";

const RENAME_ROWS: typeof FIXTURE_ROWS = [
	["src/routes/-fixtures.ts", "renamed", "implementation", 0, 0],
	["src/routes/add-channel-dialog.tsx", "renamed", "implementation", 0, 0],
	["src/routes/candidates-view.tsx", "renamed", "implementation", 0, 0],
	["src/routes/channel-problems.tsx", "renamed", "implementation", 0, 0],
	["src/routes/fold-runs.ts", "renamed", "implementation", 14, 6],
	["src/routes/reviewed-edited-rename.ts", "renamed", "implementation", 3, 1],
	["src/routes/changed-after-review.ts", "renamed", "implementation", 9, 2],
	[RENAME_LONG_PATH, "renamed", "implementation", 0, 0],
	[RENAME_BINARY_PATH, "renamed", "implementation", 0, 0],
	["src/lib/old-helper.ts", "deleted", "implementation", 0, 21],
	["src/lib/telegram-queries.ts", "modified", "implementation", 8, 3],
	["src/lib/new-helper.ts", "added", "implementation", 17, 0],
];

const RENAME_FILES = toFileChanges(RENAME_ROWS, new Set([RENAME_BINARY_PATH]));

const RENAME_REVIEWED: readonly string[] = [
	"src/routes/-fixtures.ts",
	"src/routes/reviewed-edited-rename.ts",
	RENAME_LONG_PATH,
];
const RENAME_CHANGED_AFTER_REVIEW: readonly string[] = [
	"src/routes/changed-after-review.ts",
	"src/routes/channel-problems.tsx",
];

const INITIALLY_REVIEWED: readonly string[] = [
	"src/api/projects/index.ts",
	"src/api/projects/queries.ts",
	"src/components/projects/project-card.tsx",
	"src/lib/cache/index.ts",
	"src/lib/network/retry.ts",
];

const REPO_ROOT = "/Users/dev/code/nisi";

type Scenario = {
	files: readonly FileChange[];
	reviewed: readonly string[];
	changedAfterReview: readonly string[];
};

const SCENARIOS = {
	default: {
		files: FIXTURE_FILES,
		reviewed: INITIALLY_REVIEWED,
		changedAfterReview: [],
	},
	renames: {
		files: RENAME_FILES,
		reviewed: RENAME_REVIEWED,
		changedAfterReview: RENAME_CHANGED_AFTER_REVIEW,
	},
} satisfies Record<string, Scenario>;

type StoryProps = {
	scenario: keyof typeof SCENARIOS;
	initialQuery: string;
	initialHideReviewed: boolean;
	initialCollapsed: boolean;
	initialViewMode: SidebarViewMode;
};

function reviewStateEntries(
	reviewed: ReadonlySet<string>,
	changedAfterReview: readonly string[],
): ReadonlyMap<string, ReviewStateEntry> {
	return new Map<string, ReviewStateEntry>([
		...Array.from(reviewed, (path) => [path, { status: "viewed" }] as const),
		...changedAfterReview.map(
			(path) => [path, { status: "changed-after-review" }] as const,
		),
	]);
}

function Frame(props: StoryProps): React.ReactElement {
	const scenario: Scenario = SCENARIOS[props.scenario];
	const [collapsed, setCollapsed] = useState(props.initialCollapsed);
	const [query, setQuery] = useState(props.initialQuery);
	const [searchMode, setSearchMode] = useState<SearchMode>("files");
	const [hideReviewed, setHideReviewed] = useState(props.initialHideReviewed);
	const [viewMode, setViewMode] = useState(props.initialViewMode);
	const [reviewedPaths, setReviewedPaths] = useState<ReadonlySet<string>>(
		() => new Set(scenario.reviewed),
	);
	const [selectedPath, setSelectedPath] = useState<string | null>(null);

	const reviewState = useMemo(
		() => reviewStateEntries(reviewedPaths, scenario.changedAfterReview),
		[reviewedPaths, scenario.changedAfterReview],
	);
	// Upstream of `FilesSidebar` in production (`FilesChangedView`), so the story does it too.
	const visibleFiles = useMemo(() => {
		const needle = query.toLowerCase();
		return scenario.files.filter(
			(file) =>
				!(hideReviewed && reviewedPaths.has(file.path)) &&
				file.path.toLowerCase().includes(needle),
		);
	}, [scenario.files, query, hideReviewed, reviewedPaths]);

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
		scenario: "default",
		initialQuery: "",
		initialHideReviewed: false,
		initialCollapsed: false,
		initialViewMode: "tree",
	},
	argTypes: {
		scenario: { control: "radio", options: Object.keys(SCENARIOS) },
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
/** Pure renames dim and take a hollow marker; edited and binary renames get the solid one. */
export const Renames: Story = { args: { scenario: "renames" } };
