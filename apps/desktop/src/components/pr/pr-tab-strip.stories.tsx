import type { Meta, StoryObj } from "@storybook/react-vite";
import { GitPullRequestArrowIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { GitPullRequestMergedIcon } from "#/components/icons/git-pull-request-merged";
import { PrTabIcon } from "./pr-tab-strip";

const meta: Meta<typeof PrTabIcon> = {
	title: "Pr/PrTabIcon",
	component: PrTabIcon,
	parameters: { layout: "centered", controls: { disable: true } },
};
export default meta;

type Story = StoryObj<typeof meta>;

type IconState = {
	label: string;
	props: ComponentProps<typeof PrTabIcon>;
};

/** Precedence order matches `derivePrTabStatus`/`PrTabIcon` — suspended first, then the four `"pr"`-only states. */
const STATES: readonly IconState[] = [
	{
		label: "Suspended",
		props: { isSuspended: true, kind: "pr", status: "default" },
	},
	{
		label: "Merged",
		props: { isSuspended: false, kind: "pr", status: "merged" },
	},
	{
		label: "CI running",
		props: { isSuspended: false, kind: "pr", status: "ci-running" },
	},
	{
		label: "Ready to merge",
		props: { isSuspended: false, kind: "pr", status: "ready" },
	},
	{
		label: "Default (open, no signal)",
		props: { isSuspended: false, kind: "pr", status: "default" },
	},
];

/** For contrast only — a branch tab never reaches `PrTabStatusIcon`, so this stays the plain, unchanged icon regardless of `status`. */
const BRANCH_STATE: IconState = {
	label: "Branch tab (unchanged)",
	props: { isSuspended: false, kind: "branch", status: "merged" },
};

/**
 * Every icon state the tab badge can show, side by side at its real render
 * size (`size-3.5`, 14px — the exact class `PrTabIcon` itself applies, not a
 * scaled-up stand-in) against a pill-like background, so the merged icon's
 * geometry and the semantic colors can be eyeballed without a live
 * sidecar/PR. Use the toolbar's "Theme" toggle (`preview.tsx`) to check both
 * light and dark — the same forced-theme mechanism every other story here
 * relies on, rather than this story re-implementing its own.
 */
export const AllStates: Story = {
	render: () => (
		<div className="flex gap-3 rounded-lg bg-background p-4">
			{[...STATES, BRANCH_STATE].map((state) => (
				<div
					className="flex w-28 flex-col items-center gap-2 rounded-md bg-pane-surface px-2 py-3 text-muted-foreground"
					key={state.label}
				>
					<PrTabIcon {...state.props} />
					<span className="text-center text-[10px] leading-tight">
						{state.label}
					</span>
				</div>
			))}
		</div>
	),
};

/**
 * The same states enlarged (48px, well past lucide's own 24px authoring
 * size) so the merged icon's hand-fitted arc — the actual new geometry, as
 * opposed to the unmodified nodes/branch it shares with
 * `git-pull-request-arrow` — can be checked for clean node-edge termination
 * and even spacing. `PrTabIcon` itself has no size prop (the tab badge is
 * always 14px), so this row renders the same elements at a larger CSS
 * `font-size`-independent scale via `size-12` instead of going through it.
 */
export const MergedIconDetail: Story = {
	render: () => (
		<div className="flex items-center gap-8 rounded-lg bg-background p-6 text-foreground">
			<div className="flex flex-col items-center gap-2">
				<GitPullRequestArrowIcon className="size-12 text-warning" />
				<span className="text-muted-foreground text-xs">
					git-pull-request-arrow (open)
				</span>
			</div>
			<div className="flex flex-col items-center gap-2">
				<GitPullRequestMergedIcon className="size-12 text-merged" />
				<span className="text-muted-foreground text-xs">merged (new)</span>
			</div>
		</div>
	),
};
