/**
 * Temporary Storybook coverage for `PrMergeButton`'s split-button UX, added
 * only to visually verify the GitHub-style split button (chevron flush
 * against the primary button, dropdown method picker) and the merged-state
 * fix (`resolveButtonState` no longer wedges on "Checking mergeability…"
 * once `state` is terminal) without a live sidecar/PR. Not meant to stick
 * around as permanent coverage — delete freely once verified.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PullRequestMergeStatus } from "#/lib/pr-data";
import { createMockOrpc } from "../../../.storybook/mock-orpc";
import { PrMergeButton } from "./pr-merge-button";

const BASE_STATUS: PullRequestMergeStatus = {
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["merge", "squash", "rebase"],
	defaultMethod: "merge",
};

const meta: Meta<typeof PrMergeButton> = {
	title: "Pr/PrMergeButton",
	component: PrMergeButton,
	parameters: { layout: "centered", controls: { disable: true } },
	args: {
		repoRoot: "/tmp/storybook-repo",
		owner: "acme",
		repo: "widgets",
		number: 42,
		watched: true,
	},
};
export default meta;

type Story = StoryObj<typeof meta>;

/** Repo allows all three methods — split button with a flush chevron opening the method picker. */
export const MultipleMethods: Story = {
	args: {
		orpc: createMockOrpc({ mergeStatus: BASE_STATUS }),
	},
};

/** Repo allows only one method — plain button, no chevron, no dropdown. */
export const SingleMethod: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, allowedMethods: ["squash"] },
		}),
	},
};

/**
 * A merged PR — GitHub stops computing `mergeable` once merged, so it's
 * still reported as `"UNKNOWN"` here on purpose. Before the Task B fix this
 * rendered "Checking mergeability…" forever; it should read "Merged" and be
 * disabled.
 */
export const Merged: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatus: { ...BASE_STATUS, state: "MERGED", mergeable: "UNKNOWN" },
		}),
	},
};

/**
 * `mergeStatus` fails and never once succeeds (e.g. the git worktree was
 * relocated out from under the session) — `statusQuery.data` stays
 * `undefined` forever. Before the fix, `resolveButtonState`'s
 * `status === undefined` guard caught this ahead of the `isError` check and
 * wedged the button on "Checking mergeability…" permanently; it should read
 * "Merge unavailable" and be disabled, with the error message in the title
 * tooltip.
 */
export const FailedQuery: Story = {
	args: {
		orpc: createMockOrpc({
			mergeStatusError:
				"Couldn't check whether this pull request can be merged.",
		}),
	},
};
